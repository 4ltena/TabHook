// content.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extractContent") {
    try {
      // Basic content extraction, prioritizing innerText for readable content
      const text = (document.body.innerText || document.body.textContent || "").substring(0, 10000);
      sendResponse({ content: text });
    } catch (error) {
      console.error("TabHook content extraction failed:", error);
      sendResponse({ content: "" });
    }
  }
  return true; // Keep channel open
});
