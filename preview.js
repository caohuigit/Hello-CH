const previewContainer = document.getElementById("previewContainer");
const loadingMsg = document.getElementById("loadingMsg");
const saveImgBtn = document.getElementById("saveImgBtn");
const savePdfBtn = document.getElementById("savePdfBtn");
const toolbarTitle = document.getElementById("toolbarTitle");
const toolbarStatus = document.getElementById("toolbarStatus");

let allScreenshots = [];
let captureInfo = null;

// Load all screenshots from background
async function loadScreenshots() {
  try {
    captureInfo = await sendMessage({ action: "getCaptureInfo" });
    if (!captureInfo) {
      loadingMsg.textContent = "没有截图数据，请先进行截图";
      return;
    }

    toolbarTitle.textContent =
      "截图预览 - " + captureInfo.title;

    for (let i = 0; i < captureInfo.count; i++) {
      toolbarStatus.textContent =
        "加载中 " + (i + 1) + "/" + captureInfo.count + "...";

      const shot = await sendMessage({ action: "getScreenshot", index: i });
      if (!shot) continue;
      allScreenshots.push(shot);

      // Create and display the image
      const wrapper = document.createElement("div");
      wrapper.className = "screenshot-wrapper";

      if (shot.cropInfo) {
        // Need to crop the image using canvas
        const canvas = document.createElement("canvas");
        const img = await loadImage(shot.dataUrl);
        canvas.width = shot.viewportWidth;
        canvas.height = shot.cropInfo.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(
          img,
          0,
          shot.cropInfo.yOffset,
          shot.viewportWidth,
          shot.cropInfo.height,
          0,
          0,
          shot.viewportWidth,
          shot.cropInfo.height
        );
        const croppedImg = document.createElement("img");
        croppedImg.src = canvas.toDataURL("image/png");
        wrapper.appendChild(croppedImg);
      } else {
        const imgEl = document.createElement("img");
        imgEl.src = shot.dataUrl;
        wrapper.appendChild(imgEl);
      }

      if (i === 0) {
        loadingMsg.remove();
      }
      previewContainer.appendChild(wrapper);
    }

    // Add page info
    const info = document.createElement("div");
    info.className = "page-info";
    info.textContent =
      "共 " +
      captureInfo.count +
      " 屏 | " +
      captureInfo.pageInfo.viewportWidth +
      " x " +
      captureInfo.pageInfo.scrollHeight +
      " px";
    previewContainer.appendChild(info);

    toolbarStatus.textContent = "加载完成";
    saveImgBtn.disabled = false;
    savePdfBtn.disabled = false;
  } catch (err) {
    console.error(err);
    loadingMsg.textContent = "加载失败: " + err.message;
  }
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Process all screenshots into cropped canvases
async function getProcessedImages() {
  const images = [];
  for (const shot of allScreenshots) {
    const img = await loadImage(shot.dataUrl);
    const canvas = document.createElement("canvas");
    const cropY = shot.cropInfo ? shot.cropInfo.yOffset : 0;
    const cropH = shot.cropInfo
      ? shot.cropInfo.height
      : shot.viewportHeight;
    canvas.width = shot.viewportWidth;
    canvas.height = cropH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      img,
      0,
      cropY,
      shot.viewportWidth,
      cropH,
      0,
      0,
      shot.viewportWidth,
      cropH
    );
    images.push(canvas);
  }
  return images;
}

// Save as single long image
saveImgBtn.addEventListener("click", async () => {
  saveImgBtn.disabled = true;
  savePdfBtn.disabled = true;
  toolbarStatus.textContent = "正在生成长图...";

  try {
    const images = await getProcessedImages();

    // Calculate total height
    let totalHeight = 0;
    for (const canvas of images) {
      totalHeight += canvas.height;
    }

    // Stitch into one tall canvas
    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = images[0].width;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext("2d");

    let y = 0;
    for (const canvas of images) {
      ctx.drawImage(canvas, 0, y);
      y += canvas.height;
    }

    // Download
    const link = document.createElement("a");
    link.download = getSafeFilename() + ".png";
    link.href = finalCanvas.toDataURL("image/png");
    link.click();

    toolbarStatus.textContent = "长图已保存！";
  } catch (err) {
    console.error(err);
    toolbarStatus.textContent = "保存失败: " + err.message;
  } finally {
    saveImgBtn.disabled = false;
    savePdfBtn.disabled = false;
  }
});

// Save as dual-layer PDF (image + searchable text)
savePdfBtn.addEventListener("click", async () => {
  saveImgBtn.disabled = true;
  savePdfBtn.disabled = true;
  toolbarStatus.textContent = "正在生成双层PDF...";

  try {
    const images = await getProcessedImages();
    const { jsPDF } = window.jspdf;
    const dpr = captureInfo.pageInfo.devicePixelRatio;
    const vw = captureInfo.pageInfo.viewportWidth;

    // PDF width in mm (A4 width)
    const pdfWidthMM = 210;
    // Scale: mm per device pixel
    const mmPerDevPx = pdfWidthMM / (vw * dpr);
    // Scale: mm per CSS pixel
    const mmPerCssPx = pdfWidthMM / vw;

    let pdf = null;

    for (let i = 0; i < images.length; i++) {
      toolbarStatus.textContent =
        "正在生成第 " + (i + 1) + "/" + images.length + " 页...";

      const canvas = images[i];
      const pageHeightMM = canvas.height * mmPerDevPx;
      const imgDataUrl = canvas.toDataURL("image/jpeg", 0.92);

      if (i === 0) {
        pdf = new jsPDF({
          orientation: "portrait",
          unit: "mm",
          format: [pdfWidthMM, pageHeightMM],
        });
      } else {
        pdf.addPage([pdfWidthMM, pageHeightMM]);
      }

      // --- Text layer (behind image, invisible but searchable) ---
      const shot = allScreenshots[i];
      if (shot.textData && shot.textData.length > 0) {
        // Set text rendering mode to invisible (mode 3)
        pdf.internal.write("3 Tr");

        for (const item of shot.textData) {
          // Convert CSS pixel positions to PDF mm
          let textX = item.x * mmPerCssPx;
          let textY = item.y * mmPerCssPx;

          // Adjust for crop on last page
          if (shot.cropInfo) {
            const cropOffsetCSS = shot.cropInfo.yOffset / dpr;
            textY -= cropOffsetCSS * mmPerCssPx;
          }

          // Skip text outside page bounds
          if (textY < 0 || textY > pageHeightMM) continue;
          if (textX < 0 || textX > pdfWidthMM) continue;

          const fontSizePt = item.fontSize * mmPerCssPx * (72 / 25.4);
          if (fontSizePt < 2 || fontSizePt > 200) continue;

          pdf.setFontSize(fontSizePt);
          const maxWidth = item.width * mmPerCssPx;

          try {
            pdf.text(item.text, textX, textY + item.height * mmPerCssPx * 0.8, {
              maxWidth: maxWidth > 0 ? maxWidth : undefined,
            });
          } catch (e) {
            // Skip problematic text entries
          }
        }

        // Reset text rendering mode to normal for any subsequent operations
        pdf.internal.write("0 Tr");
      }

      // --- Image layer (on top, covering the text) ---
      pdf.addImage(imgDataUrl, "JPEG", 0, 0, pdfWidthMM, pageHeightMM);

      // Allow UI to update
      await new Promise((r) => setTimeout(r, 10));
    }

    // Save PDF
    pdf.save(getSafeFilename() + ".pdf");
    toolbarStatus.textContent = "双层PDF已保存！";
  } catch (err) {
    console.error(err);
    toolbarStatus.textContent = "保存失败: " + err.message;
  } finally {
    saveImgBtn.disabled = false;
    savePdfBtn.disabled = false;
  }
});

function getSafeFilename() {
  const title = captureInfo ? captureInfo.title : "screenshot";
  return title.replace(/[^\w\u4e00-\u9fa5\-]/g, "_").substring(0, 100);
}

// Start loading
loadScreenshots();
