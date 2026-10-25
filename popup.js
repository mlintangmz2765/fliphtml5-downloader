document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('downloadBtn');
    const statusDiv = document.getElementById('status');

    function loadImageFromBlob(blob) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(objectUrl);
                resolve(img);
            };
            img.onerror = (err) => {
                URL.revokeObjectURL(objectUrl);
                reject(err);
            };
            img.src = objectUrl;
        });
    }

    function convertImageToJpegDataUrl(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');

        // Berikan background putih untuk menangani transparansi
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        // Ekspor sebagai JPEG murni untuk kompatibilitas penuh dengan jsPDF
        return canvas.toDataURL('image/jpeg', 0.95);
    }

    btn.addEventListener('click', async () => {
        statusDiv.innerText = "Checking active tab...";
        btn.disabled = true;

        let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab || (!tab.url.includes('fliphtml5.com') && !tab.url.includes('fliphtml5.net'))) {
            statusDiv.innerHTML = "<span style='color:red;'>Error:</span> Please open a FlipHTML5 book page first!";
            btn.disabled = false;
            return;
        }

        try {
            statusDiv.innerText = "Extracting book data...";

            let [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: "MAIN",
                func: () => {
                    if (window.fliphtml5_pages && Array.isArray(window.fliphtml5_pages)) {
                        return window.fliphtml5_pages.map(p => ({
                            n: p.n || null,
                            l: p.l || null
                        }));
                    }
                    if (window.bookConfig && window.bookConfig.totalPageCount) {
                        return { error: "Metadata detected, but image pages are hard-locked." };
                    }
                    return null;
                }
            });

            if (result && result.error) {
                statusDiv.innerHTML = `<span style='color:red;'>Failed:</span> ${result.error}`;
                btn.disabled = false;
                return;
            }

            if (!result || result.length === 0) {
                statusDiv.innerHTML = "<span style='color:red;'>Failed to find images!</span><br>The book might be highly protected or not fully loaded.";
                btn.disabled = false;
                return;
            }

            let pages = result;
            let baseUrl = new URL(tab.url);

            // Parsing path dan base origin yang aman untuk berbagai struktur URL
            let pathSegments = baseUrl.pathname.split('/').filter(Boolean);
            if (pathSegments.length > 0 && pathSegments[pathSegments.length - 1].includes('.')) {
                pathSegments.pop(); // buang misal 'index.html'
            }
            let basePath = '/' + (pathSegments.length > 0 ? pathSegments.join('/') + '/' : '');
            let baseOrigin = baseUrl.origin + basePath;

            // Bersihkan nama file agar tidak ada karakter terlarang
            let rawBookId = pathSegments[pathSegments.length - 1] || "FlipHTML5_Book";
            let bookId = rawBookId.replace(/[^a-zA-Z0-9_\-]/g, '_');

            statusDiv.innerText = `Found ${pages.length} pages. Starting PDF generation...`;

            const { jsPDF } = window.jspdf;
            let pdf = null;
            let processedCount = 0;

            for (let i = 0; i < pages.length; i++) {
                let pageObj = pages[i];
                let rawPath = pageObj.n || pageObj.l;

                // Tangani jika n atau l berupa Array
                if (Array.isArray(rawPath)) {
                    rawPath = rawPath[0];
                }

                if (!rawPath || typeof rawPath !== 'string') {
                    console.warn(`Skipping invalid page data at index ${i}`, pageObj);
                    continue;
                }

                // Bersihkan slash pembuka jika ada
                if (rawPath.startsWith('/')) {
                    rawPath = rawPath.slice(1);
                }

                let fileUrl = rawPath.startsWith('http') ? rawPath : baseOrigin + rawPath;

                statusDiv.innerText = `Processing page ${i + 1} of ${pages.length}...`;

                try {
                    let response = await fetch(fileUrl);
                    if (!response.ok) throw new Error("HTTP " + response.status);

                    let blob = await response.blob();
                    let img = await loadImageFromBlob(blob);

                    // Konversi ke format JPEG via Canvas (mencegah crash decoding WebP internal di jsPDF)
                    let jpegDataUrl = convertImageToJpegDataUrl(img);

                    let orientation = img.naturalWidth > img.naturalHeight ? 'l' : 'p';

                    if (pdf === null) {
                        pdf = new jsPDF({
                            orientation: orientation,
                            unit: 'px',
                            format: [img.naturalWidth, img.naturalHeight]
                        });
                        pdf.addImage(jpegDataUrl, 'JPEG', 0, 0, img.naturalWidth, img.naturalHeight);
                    } else {
                        pdf.addPage([img.naturalWidth, img.naturalHeight], orientation);
                        pdf.addImage(jpegDataUrl, 'JPEG', 0, 0, img.naturalWidth, img.naturalHeight);
                    }

                    processedCount++;

                } catch (imgError) {
                    console.error(`Failed to process page ${fileUrl}:`, imgError);
                }

                await new Promise(r => setTimeout(r, 60));
            }

            if (processedCount > 0) {
                statusDiv.innerText = "Finalizing PDF... please wait!";

                const fileName = `${bookId}.pdf`;

                try {
                    pdf.save(fileName);
                } catch (saveErr) {
                    console.warn("Standard pdf.save failed, trying Blob download fallback:", saveErr);
                    const pdfBlob = pdf.output('blob');
                    const blobUrl = URL.createObjectURL(pdfBlob);
                    const downloadLink = document.createElement('a');
                    downloadLink.href = blobUrl;
                    downloadLink.download = fileName;
                    document.body.appendChild(downloadLink);
                    downloadLink.click();
                    document.body.removeChild(downloadLink);
                }

                statusDiv.innerHTML = `<span style='color:green;font-weight:bold;'>Success!</span><br>PDF with ${processedCount} pages has been downloaded.`;
            } else {
                statusDiv.innerHTML = `<span style='color:red;'>Failed:</span> No pages were successfully processed.`;
            }

        } catch (e) {
            console.error("Critical error in FlipHTML5 Downloader:", e);
            statusDiv.innerHTML = `<span style='color:red;'>Critical error:</span> ${e.message || "Open console for details."}`;
        }

        btn.disabled = false;
    });
});
