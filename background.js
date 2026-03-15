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
  // ---------------------------------------------------------------
  // STEP 1: Inject persistent CSS overrides that stay active for the
  //         entire capture process. This fixes two critical issues:
  //   a) overflow:hidden on html/body → scrollHeight === clientHeight
  //   b) scroll-behavior:smooth → scrollTo animates instead of jumping
  //
  //   We also save original inline styles so we can restore later.
  // ---------------------------------------------------------------
  const [{ result: setupResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const html = document.documentElement;
      const body = document.body;

      // Save original inline styles for later restoration
      const saved = {
        htmlOverflow: html.style.overflow,
        htmlOverflowY: html.style.overflowY,
        bodyOverflow: body.style.overflow,
        bodyOverflowY: body.style.overflowY,
      };

      // Inject a <style> that forces scrolling to work.
      // Using a <style> tag with !important beats any CSS rules on the page.
      let styleEl = document.getElementById("__scroll_capture_style__");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "__scroll_capture_style__";
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = [
        "html, body {",
        "  overflow-y: auto !important;",
        "  overflow-x: hidden !important;",
        "  scroll-behavior: auto !important;",
        "}",
        // Some pages set height:100vh on html/body, which caps scrollHeight
        "html { height: auto !important; min-height: 100vh !important; }",
        "body { height: auto !important; min-height: 100vh !important; }",
        // Disable smooth scrolling on all elements
        "* { scroll-behavior: auto !important; }",
      ].join("\n");

      // Scroll to top
      window.scrollTo(0, 0);

      return saved;
    },
  });

  // Let the CSS override take effect and layout recalculate
  await delay(500);

  // ---------------------------------------------------------------
  // STEP 2: Measure page height AFTER the CSS override is active.
  //         Use multiple methods and take the maximum.
  // ---------------------------------------------------------------
  const [{ result: pageInfo }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const html = document.documentElement;
      const body = document.body;

      // Method 1: standard scrollHeight / offsetHeight
      let maxHeight = Math.max(
        html.scrollHeight,
        html.offsetHeight,
        body.scrollHeight,
        body.offsetHeight
      );

      // Method 2: scan top-level body children for their actual bottom edge.
      // This catches cases where scrollHeight is still capped.
      const children = body.children;
      for (let i = 0; i < children.length; i++) {
        const rect = children[i].getBoundingClientRect();
        const bottom = rect.bottom + window.scrollY;
        if (bottom > maxHeight) {
          maxHeight = bottom;
        }
      }

      return {
        scrollHeight: Math.ceil(maxHeight),
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    },
  });

  const tab = await chrome.tabs.get(tabId);
  const title = tab.title || "screenshot";

  const { viewportHeight, viewportWidth, devicePixelRatio } = pageInfo;
  let scrollHeight = pageInfo.scrollHeight;
  let totalSteps = Math.ceil(scrollHeight / viewportHeight);
  const screenshots = [];

  // ---------------------------------------------------------------
  // STEP 3: Capture loop — scroll, wait, capture, extract text
  // ---------------------------------------------------------------
  for (let i = 0; i < totalSteps; i++) {
    const targetScrollY = i * viewportHeight;

    // --- SCROLL ---
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => {
        window.scrollTo(0, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
      },
      args: [targetScrollY],
    });

    // Wait for repaint
    await delay(600);

    // --- VERIFY + RE-MEASURE ---
    const [{ result: scrollState }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const html = document.documentElement;
        const body = document.body;
        let h = Math.max(
          html.scrollHeight,
          html.offsetHeight,
          body.scrollHeight,
          body.offsetHeight
        );
        const children = body.children;
        for (let i = 0; i < children.length; i++) {
          const rect = children[i].getBoundingClientRect();
          const bottom = rect.bottom + window.scrollY;
          if (bottom > h) h = bottom;
        }
        return {
          scrollY: window.scrollY || html.scrollTop || body.scrollTop,
          scrollHeight: Math.ceil(h),
        };
      },
    });

    // If page grew (lazy loading), update totalSteps
    if (scrollState.scrollHeight > scrollHeight) {
      scrollHeight = scrollState.scrollHeight;
      totalSteps = Math.ceil(scrollHeight / viewportHeight);
    }

    // If scroll didn't reach target, retry
    if (
      i > 0 &&
      Math.abs(scrollState.scrollY - targetScrollY) > 5 &&
      targetScrollY <= scrollHeight - viewportHeight
    ) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y) => {
          document.documentElement.scrollTop = y;
          document.body.scrollTop = y;
          window.scrollTo(0, y);
        },
        args: [targetScrollY],
      });
      await delay(600);
    }

    // --- CAPTURE ---
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });

    await delay(100);

    // --- EXTRACT TEXT for dual-layer PDF ---
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

            for (const rect of rects) {
              if (rect.width < 1 || rect.height < 1) continue;
              if (rect.bottom < 0 || rect.top > vh) continue;

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

    // --- CROP INFO for last screenshot ---
    const isLast = i === totalSteps - 1;
    let cropInfo = null;

    if (isLast && totalSteps > 1) {
      const maxScrollY = scrollHeight - viewportHeight;
      if (targetScrollY > maxScrollY) {
        const overlap = targetScrollY - maxScrollY;
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

    // Send progress to popup (if still open)
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

  // ---------------------------------------------------------------
  // STEP 4: Cleanup — remove injected CSS, restore styles, scroll top
  // ---------------------------------------------------------------
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (saved) => {
      // Remove the injected <style>
      const s = document.getElementById("__scroll_capture_style__");
      if (s) s.remove();

      // Restore original inline styles
      const html = document.documentElement;
      const body = document.body;
      html.style.overflow = saved.htmlOverflow;
      html.style.overflowY = saved.htmlOverflowY;
      body.style.overflow = saved.bodyOverflow;
      body.style.overflowY = saved.bodyOverflowY;

      window.scrollTo(0, 0);
    },
    args: [setupResult],
  });

  // Store captured data
  capturedData = {
    screenshots,
    pageInfo: {
      scrollHeight,
      viewportHeight,
      viewportWidth,
      devicePixelRatio,
    },
    title,
  };

  // Open preview page in new tab
  chrome.tabs.create({
    url: chrome.runtime.getURL("preview.html"),
  });
}
