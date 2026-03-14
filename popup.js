const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressInner = document.getElementById("progressInner");

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setProgress(pct) {
  progressBar.classList.add("active");
  progressInner.style.width = pct + "%";
}

function resetUI() {
  captureBtn.disabled = false;
  progressBar.classList.remove("active");
  progressInner.style.width = "0%";
}

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  setStatus("正在准备截图...");
  setProgress(0);

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    // Inject content script to get page dimensions and perform scrolling
    const [{ result: pageInfo }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: getPageInfo,
    });

    const { scrollHeight, viewportHeight, viewportWidth, devicePixelRatio } =
      pageInfo;
    const totalSteps = Math.ceil(scrollHeight / viewportHeight);

    setStatus(`共需截取 ${totalSteps} 屏...`);

    const screenshots = [];

    for (let i = 0; i < totalSteps; i++) {
      const scrollY = i * viewportHeight;
      const isLast = i === totalSteps - 1;

      // Scroll to position
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollTo,
        args: [scrollY],
      });

      // Wait for rendering
      await delay(300);

      // Capture visible tab
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "png",
      });

      // For the last screenshot, we may need to crop it
      let cropHeight = viewportHeight * devicePixelRatio;
      if (isLast) {
        const remainder = scrollHeight - scrollY;
        if (remainder < viewportHeight) {
          // Need to crop: only take the bottom portion
          const actualCropHeight = remainder * devicePixelRatio;
          const yOffset = (viewportHeight - remainder) * devicePixelRatio;
          screenshots.push({
            dataUrl,
            cropY: yOffset,
            cropHeight: actualCropHeight,
            fullWidth: viewportWidth * devicePixelRatio,
            fullHeight: viewportHeight * devicePixelRatio,
          });
        } else {
          screenshots.push({
            dataUrl,
            cropY: 0,
            cropHeight,
            fullWidth: viewportWidth * devicePixelRatio,
            fullHeight: viewportHeight * devicePixelRatio,
          });
        }
      } else {
        screenshots.push({
          dataUrl,
          cropY: 0,
          cropHeight,
          fullWidth: viewportWidth * devicePixelRatio,
          fullHeight: viewportHeight * devicePixelRatio,
        });
      }

      setProgress(Math.round(((i + 1) / totalSteps) * 80));
      setStatus(`已截取 ${i + 1}/${totalSteps} 屏`);
    }

    // Scroll back to top
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrollTo,
      args: [0],
    });

    setStatus("正在生成PDF...");
    setProgress(85);

    await generatePDF(screenshots, viewportWidth, devicePixelRatio, tab.title);

    setProgress(100);
    setStatus("PDF已保存！");
    setTimeout(resetUI, 2000);
  } catch (err) {
    console.error(err);
    setStatus("出错了: " + err.message);
    resetUI();
  }
});

function getPageInfo() {
  return {
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}

function scrollTo(y) {
  window.scrollTo({ top: y, behavior: "instant" });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generatePDF(screenshots, viewportWidth, dpr, title) {
  // Load images and crop them using canvas
  const processedImages = [];

  for (const shot of screenshots) {
    const img = await loadImage(shot.dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = shot.fullWidth;
    canvas.height = shot.cropHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(
      img,
      0,
      shot.cropY,
      shot.fullWidth,
      shot.cropHeight,
      0,
      0,
      shot.fullWidth,
      shot.cropHeight
    );
    processedImages.push({
      dataUrl: canvas.toDataURL("image/jpeg", 0.92),
      width: shot.fullWidth,
      height: shot.cropHeight,
    });
  }

  // Calculate PDF dimensions (A4-width based, variable height)
  const pdfWidthMM = 210; // A4 width in mm
  const marginMM = 0;
  const contentWidthMM = pdfWidthMM - 2 * marginMM;

  // Calculate total height
  const pixelWidth = viewportWidth * dpr;
  const scale = contentWidthMM / pixelWidth;

  // Create PDF with first page
  const firstImg = processedImages[0];
  const firstHeightMM = firstImg.height * scale;

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({
    orientation: firstHeightMM > pdfWidthMM ? "portrait" : "landscape",
    unit: "mm",
    format: [pdfWidthMM, firstHeightMM],
  });

  pdf.addImage(
    firstImg.dataUrl,
    "JPEG",
    marginMM,
    0,
    contentWidthMM,
    firstHeightMM
  );

  // Add remaining pages
  for (let i = 1; i < processedImages.length; i++) {
    const img = processedImages[i];
    const heightMM = img.height * scale;
    pdf.addPage([pdfWidthMM, heightMM]);
    pdf.addImage(img.dataUrl, "JPEG", marginMM, 0, contentWidthMM, heightMM);
  }

  // Save
  const safeName = (title || "screenshot").replace(/[^\w\u4e00-\u9fa5]/g, "_");
  pdf.save(`${safeName}.pdf`);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
