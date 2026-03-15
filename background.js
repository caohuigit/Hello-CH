// Store captured data for preview page to retrieve
let capturedData = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startCapture") {
    captureFullPage(message.tabId)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("Capture failed:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  if (message.action === "getCaptureInfo") {
    if (!capturedData) {
      sendResponse(null);
    } else {
      sendResponse({
        count: capturedData.screenshots.length,
        pageInfo: capturedData.pageInfo,
        title: capturedData.title,
      });
    }
    return;
  }

  if (message.action === "getScreenshot") {
    if (!capturedData || message.index >= capturedData.screenshots.length) {
      sendResponse(null);
    } else {
      sendResponse(capturedData.screenshots[message.index]);
    }
    return;
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureFullPage(tabId) {
  // Get page info
  const [{ result: pageInfo }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return {
        scrollHeight: Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight
        ),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    },
  });

  // Get page title
  const tab = await chrome.tabs.get(tabId);
  const title = tab.title || "screenshot";

  const { scrollHeight, viewportHeight, viewportWidth, devicePixelRatio } =
    pageInfo;
  const totalSteps = Math.ceil(scrollHeight / viewportHeight);
  const screenshots = [];

  // First, scroll to top and wait for initial render
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      window.scrollTo(0, 0);
    },
  });
  await delay(300);

  for (let i = 0; i < totalSteps; i++) {
    const targetScrollY = i * viewportHeight;

    // Scroll to target position, then wait for TWO animation frames
    // to guarantee the browser has fully painted the new scroll position.
    // Without this, captureVisibleTab captures stale (pre-scroll) pixels.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => {
        return new Promise((resolve) => {
          window.scrollTo(0, y);
          // First rAF: browser schedules repaint
          requestAnimationFrame(() => {
            // Second rAF: repaint has been committed to screen
            requestAnimationFrame(() => {
              resolve(window.scrollY);
            });
          });
        });
      },
      args: [targetScrollY],
    });

    // Additional safety delay for heavy pages (images, lazy-load, etc.)
    await delay(350);

    // Verify scroll actually happened; retry if needed
    const [{ result: confirmedScrollY }] =
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.scrollY,
      });

    if (
      i > 0 &&
      Math.abs(confirmedScrollY - targetScrollY) > 2 &&
      targetScrollY <= scrollHeight - viewportHeight
    ) {
      // Retry scroll with longer wait
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y) => {
          return new Promise((resolve) => {
            window.scrollTo(0, y);
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          });
        },
        args: [targetScrollY],
      });
      await delay(500);
    }

    // NOW capture — the screen has definitely been repainted
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });

    // Extract visible text with positions for dual-layer PDF
    let textData = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const results = [];
          const vh = window.innerHeight;
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                const t = node.textContent.trim();
                if (!t) return NodeFilter.FILTER_REJECT;
                const el = node.parentElement;
                if (!el) return NodeFilter.FILTER_REJECT;
                const s = getComputedStyle(el);
                if (
                  s.display === "none" ||
                  s.visibility === "hidden" ||
                  s.opacity === "0"
                )
                  return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
              },
            }
          );

          while (walker.nextNode()) {
            const node = walker.currentNode;
            const text = node.textContent.trim();
            if (!text) continue;

            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = range.getClientRects();
            if (rects.length === 0) continue;

            const el = node.parentElement;
            const fontSize = parseFloat(getComputedStyle(el).fontSize);

            // Use each client rect as a separate text line
            for (const rect of rects) {
              if (rect.width < 1 || rect.height < 1) continue;
              if (rect.bottom < 0 || rect.top > vh) continue;

              // Approximate the text content for this rect line
              // For multi-line text, distribute chars proportionally
              const charPerRect = Math.max(
                1,
                Math.round(text.length / rects.length)
              );
              const rectIndex = Array.from(rects).indexOf(rect);
              const lineText = text.substring(
                rectIndex * charPerRect,
                (rectIndex + 1) * charPerRect
              );

              results.push({
                text: lineText || text,
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
                fontSize: fontSize,
              });
            }
          }
          return results;
        },
      });
      textData = result || [];
    } catch (e) {
      console.warn("Text extraction failed for step", i, e);
    }

    // Calculate crop info for the last screenshot
    const isLast = i === totalSteps - 1;
    let cropInfo = null;

    if (isLast && totalSteps > 1) {
      const expectedScrollY = targetScrollY;
      const maxScrollY = scrollHeight - viewportHeight;
      if (expectedScrollY > maxScrollY) {
        // Browser clamped the scroll, so there's overlap with previous screenshot
        const overlap = expectedScrollY - maxScrollY;
        cropInfo = {
          yOffset: overlap * devicePixelRatio,
          height: (viewportHeight - overlap) * devicePixelRatio,
        };
      }
    }

    screenshots.push({
      dataUrl,
      textData,
      cropInfo,
      viewportWidth: viewportWidth * devicePixelRatio,
      viewportHeight: viewportHeight * devicePixelRatio,
    });

    // Send progress to popup (if it's still open)
    try {
      chrome.runtime.sendMessage({
        action: "captureProgress",
        current: i + 1,
        total: totalSteps,
      });
    } catch (e) {
      // Popup may be closed, ignore
    }
  }

  // Scroll back to top
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.scrollTo(0, 0),
  });

  // Store captured data
  capturedData = {
    screenshots,
    pageInfo,
    title,
  };

  // Open preview page in new tab
  chrome.tabs.create({
    url: chrome.runtime.getURL("preview.html"),
  });
}
