// TabHook - Background script for timer logic

const STORAGE_KEYS = {
  ACTIVE_TABS: 'activeTabs',
  SETTINGS: ['api_mode', 'api_key', 'timer_duration', 'api_provider', 'local_type', 'local_port', 'local_model']
};

const ACTIONS = {
  EXTRACT_CONTENT: 'extractContent',
  SWITCH_TO_TAB: 'switchToTab',
  RESET_TRACKING: 'resetTracking',
  UPDATE_SETTINGS: 'updateSettings'
};

const DEFAULTS = {
  API_MODE: 'public',
  TIMER_DURATION: 10,
  API_PROVIDER: 'openai',
  LOCAL_TYPE: 'wsl_ollama',
  LOCAL_PORT: 11435,
  LOCAL_MODEL: 'llama3'
};

// Helper: Get activeTabs from storage (Promise-based)
async function getTabsMap() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.ACTIVE_TABS]);
  const data = result[STORAGE_KEYS.ACTIVE_TABS] || {};
  return new Map(Object.entries(data));
}

// Helper: Save activeTabs to storage (Promise-based)
async function saveTabsMap(activeTabsMap) {
  const data = Object.fromEntries(activeTabsMap);
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE_TABS]: data });
}

// Helper: Get all settings (Promise-based)
async function getSettings() {
  return await chrome.storage.sync.get(STORAGE_KEYS.SETTINGS);
}

// Initialize on install or startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log("TabHook installed/updated - initializing tabs and alarm");

  // Set default settings
  const settings = await getSettings();
  const updates = {};
  if (!settings.api_mode) updates.api_mode = DEFAULTS.API_MODE;
  if (!settings.timer_duration) updates.timer_duration = DEFAULTS.TIMER_DURATION;
  if (!settings.api_provider) updates.api_provider = DEFAULTS.API_PROVIDER;
  if (!settings.local_type) updates.local_type = DEFAULTS.LOCAL_TYPE;
  if (!settings.local_port) updates.local_port = DEFAULTS.LOCAL_PORT;
  if (!settings.local_model) updates.local_model = DEFAULTS.LOCAL_MODEL;
  
  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }

  // Create alarm for checking tabs
  chrome.alarms.create('checkTabs', { periodInMinutes: 1 });

  // Initial scan to track currently abandoned tabs
  await initializeTabState();
});

// Helper to initialize tab state on startup/install
async function initializeTabState() {
  const [tabs, focusedWindow] = await Promise.all([
    chrome.tabs.query({}),
    chrome.windows.getLastFocused({ populate: false })
  ]);

  const activeTabsList = await chrome.tabs.query({ 
    active: true, 
    windowId: focusedWindow?.id 
  });

  const currentActiveTabId = activeTabsList.length > 0 ? activeTabsList[0].id : null;
  const chromeIsFocused = focusedWindow?.focused || false;
  const activeTabsMap = new Map();
  const now = Date.now();

  tabs.forEach(tab => {
    if (tab.url) {
      const isActive = chromeIsFocused && (tab.id === currentActiveTabId);
      activeTabsMap.set(tab.id.toString(), {
        startTime: isActive ? null : now,
        url: tab.url,
        title: tab.title,
        isActive: isActive
      });
    }
  });

  await saveTabsMap(activeTabsMap);
  console.log(`Initialized tracking for ${activeTabsMap.size} tabs. Browser focused: ${chromeIsFocused}`);
}

// Listen for alarm events
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkTabs') {
    await checkActiveTabs();
  }
});

// Centralized function to update tab state
async function updateTabTracking() {
  const [activeTabsMap, allTabs, focusedWindow] = await Promise.all([
    getTabsMap(),
    chrome.tabs.query({}),
    chrome.windows.getLastFocused({ populate: false })
  ]);

  const chromeIsFocused = focusedWindow?.focused || false;
  const now = Date.now();

  allTabs.forEach(tab => {
    const tabIdStr = tab.id.toString();
    if (!activeTabsMap.has(tabIdStr)) {
      // New tab, initialize tracking
      activeTabsMap.set(tabIdStr, {
        url: tab.url,
        title: tab.title,
        isActive: false,
        startTime: now
      });
    }

    const data = activeTabsMap.get(tabIdStr);
    const isCurrentlyActiveInWindow = tab.active && focusedWindow && tab.windowId === focusedWindow.id;
    const isReallyActive = chromeIsFocused && isCurrentlyActiveInWindow;

    if (isReallyActive && !data.isActive) {
      data.isActive = true;
      data.startTime = null;
    } else if (!isReallyActive && data.isActive) {
      data.isActive = false;
      data.startTime = now;
    }
    
    // Always update title/url in case they changed
    data.url = tab.url;
    data.title = tab.title;
    activeTabsMap.set(tabIdStr, data);
  });

  await saveTabsMap(activeTabsMap);
}

// Listen for tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    await updateTabTracking();
  }
});

// Listen for tab activation
chrome.tabs.onActivated.addListener(async () => {
  await updateTabTracking();
});

// Listen for window focus changes
chrome.windows.onFocusChanged.addListener(async () => {
  await updateTabTracking();
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const activeTabs = await getTabsMap();
  if (activeTabs.delete(tabId.toString())) {
    await saveTabsMap(activeTabs);
  }
});

// Listen for system idle/locked state changes
chrome.idle.onStateChanged.addListener((newState) => {
  console.log(`System idle state changed to: ${newState}`);
  if (newState === 'active') {
    // When returning to the PC, check immediately for any tabs that timed out while locked
    checkActiveTabs();
  }
});

// Check activeTabs for timeout
async function checkActiveTabs() {
  const now = Date.now();
  
  // Skip if we're locked
  const state = await new Promise(resolve => chrome.idle.queryState(15, resolve));
  if (state === 'locked') {
    console.log("System is locked - skipping notification check");
    return;
  }

  const settings = await getSettings();
  const timerDuration = settings.timer_duration || DEFAULTS.TIMER_DURATION;
  const apiMode = settings.api_mode || DEFAULTS.API_MODE;
  const apiProvider = settings.api_provider || DEFAULTS.API_PROVIDER;
  const apiKey = settings.api_key;
  const localType = settings.local_type || DEFAULTS.LOCAL_TYPE;
  const localPort = settings.local_port || DEFAULTS.LOCAL_PORT;
  const localModel = settings.local_model || DEFAULTS.LOCAL_MODEL;
  
  const timeoutThreshold = timerDuration * 60 * 1000;

  const activeTabsMap = await getTabsMap();
  let updated = false;

  for (const [tabIdStr, tabInfo] of activeTabsMap.entries()) {
    if (!tabInfo.isActive && tabInfo.startTime) {
      const abandonedTime = now - tabInfo.startTime;

      if (abandonedTime > timeoutThreshold) {
        console.log(`Tab ${tabIdStr} abandoned for ${abandonedTime / 1000}s.`);
        
        let config = { apiMode, apiProvider, apiKey, localType, localPort, localModel };
        await showCuriosityNotification(parseInt(tabIdStr), tabInfo, config);
        
        // Reset timer for next interval
        tabInfo.startTime = now; 
        activeTabsMap.set(tabIdStr, tabInfo);
        updated = true;
      }
    }
  }

  if (updated) {
    await saveTabsMap(activeTabsMap);
  }
}

// AI Provider Registry
const AI_PROVIDERS = {
  openai: generateSummaryWithOpenAI,
  claude: generateSummaryWithClaude,
  gemini: generateSummaryWithGemini
};

// Show curiosity notification
async function showCuriosityNotification(tabId, tabInfo, config) {
  const { apiMode, apiProvider, apiKey, localPort, localModel } = config;

  if (apiMode === 'public' && !apiKey) {
    showNotificationUI(tabId, tabInfo, chrome.i18n.getMessage("noApiKeyError"));
    return;
  }

  try {
    const content = await extractPageContent(tabId, tabInfo);
    let summary;

    if (apiMode === 'local') {
      summary = await generateSummaryWithOllama(content, localModel, localPort, tabInfo.url);
    } else {
      const providerFn = AI_PROVIDERS[apiProvider] || AI_PROVIDERS.openai;
      summary = await providerFn(content, apiKey, tabInfo.url);
    }
    
    showNotificationUI(tabId, tabInfo, summary);
  } catch (error) {
    console.error("Error in curiosity notification:", error);
  }
}

// Extract page content
async function extractPageContent(tabId, tabInfo) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: ACTIONS.EXTRACT_CONTENT });
    return response?.content || `Content from ${tabInfo.title} at ${tabInfo.url}`;
  } catch (error) {
    console.warn(`Could not extract content from tab ${tabId}:`, error);
    return `Content from ${tabInfo.title} at ${tabInfo.url}`;
  }
}

// AI Summary Implementation Helpers
function getFormattedPrompt(targetUrl, content) {
  const promptKey = (targetUrl && targetUrl.startsWith('chrome://')) ? "aiPromptNewTab" : "aiPromptNormal";
  const template = chrome.i18n.getMessage(promptKey);
  return `${template}\n\n${content}`;
}

async function generateSummaryWithOpenAI(content, apiKey, targetUrl) {
  // Use the helper for consistency even in mocks
  const prompt = getFormattedPrompt(targetUrl, content);
  return `興味深い内容の断片: ${content.substring(0, 40)}...\nこの続き、まだ気になりませんか？`;
}

async function generateSummaryWithClaude(content, apiKey, targetUrl) {
  const prompt = getFormattedPrompt(targetUrl, content);
  return `要点: ${content.substring(0, 40)}...\n読みかけのままにするには勿体ない内容です。`;
}

// Ollama Implementation
async function generateSummaryWithOllama(content, model, port, targetUrl) {
  const promptText = getFormattedPrompt(targetUrl, content);
  
  const OLLAMA_URL = `http://localhost:${port || DEFAULTS.LOCAL_PORT}/api/generate`;
  const payload = {
    model: model || DEFAULTS.LOCAL_MODEL,
    prompt: promptText,
    stream: false,
    keep_alive: 0
  };

  try {
    const response = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error (${response.status}): ${errorText}`);
    }
    
    const data = await response.json();
    return data.response || "No response from Ollama";
  } catch (error) {
    console.error("Ollama connection failed:", error);
    throw error;
  }
}

// Fetch available flash models dynamically, ordered by latest
async function getFlashModelsOrderByLatest(apiKey) {
  const defaultModels = ["models/gemini-2.0-flash", "models/gemini-1.5-flash", "models/gemini-1.5-flash-8b"];
  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listResponse = await fetch(listUrl);
    const listData = await listResponse.json();
    if (listData && listData.models) {
      const flashModels = listData.models
        .filter(m => m.name.includes("flash") && m.supportedGenerationMethods.includes("generateContent"))
        .sort((a, b) => b.name.localeCompare(a.name))
        .map(m => m.name);
      
      return flashModels.length > 0 ? flashModels : defaultModels;
    }
  } catch (err) {
    console.error("Error fetching model list:", err);
  }
  return defaultModels;
}

// Generate summary using Gemini API
async function generateSummaryWithGemini(content, apiKey, targetUrl) {
  const modelList = await getFlashModelsOrderByLatest(apiKey);
  modelList.push("models/gemini-1.0-pro");
  
  const promptText = getFormattedPrompt(targetUrl, content);
  const payload = { contents: [{ parts: [{ text: promptText }] }] };
  
  for (const modelName of modelList) {
    try {
      console.log(`Attempting summary with model: ${modelName}`);
      const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(geminiApiUrl, { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(payload) 
      });
      
      const data = await response.json();
      
      if (data.error) {
        if (data.error.code === 429 || data.error.code === 404) {
          console.warn(`Model ${modelName} failed (${data.error.code}).`);
          continue; 
        }
        throw new Error(data.error.message);
      }
      
      if (data.candidates?.[0]?.content) {
        return data.candidates[0].content.parts[0].text;
      }
    } catch (err) {
      console.error(`Error with model ${modelName}:`, err);
      if (modelName === modelList[modelList.length - 1]) throw err;
    }
  }
  throw new Error("All available Gemini models failed.");
}

// Desktop notification click listener
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('tabhook_')) {
    const tabId = parseInt(notificationId.split('_')[1]);
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (error) {
      console.error("Failed to focus tab on notification click:", error);
    }
  }
});

// Show notification UI
function showNotificationUI(tabId, tabInfo, summary) {
  const options = {
    type: "basic",
    iconUrl: "icon128.png",
    title: chrome.i18n.getMessage("notificationTitle"),
    message: summary.replace(/\n/g, " ").substring(0, 100) + "...",
    priority: 2
  };
  chrome.notifications.create(`tabhook_${tabId}_${Date.now()}`, options);
}

// Message listeners for UI interaction
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handleMessage = async () => {
    switch (request.action) {
      case ACTIONS.SWITCH_TO_TAB:
        const tab = await chrome.tabs.update(request.targetTabId, { active: true });
        if (tab?.windowId) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { success: true };

      case ACTIONS.RESET_TRACKING:
        await chrome.storage.local.clear();
        await initializeTabState();
        return { success: true };

      case ACTIONS.UPDATE_SETTINGS:
        await chrome.storage.sync.set({ 
          api_mode: request.api_mode,
          api_key: request.api_key, 
          timer_duration: request.timer_duration, 
          api_provider: request.api_provider,
          local_type: request.local_type,
          local_port: request.local_port,
          local_model: request.local_model
        });
        return { success: true };
        
      default:
        return { error: "Unknown action" };
    }
  };

  handleMessage().then(sendResponse);
  return true; // Keep message channel open for async response
});