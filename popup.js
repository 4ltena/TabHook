const ACTIONS = {
  RESET_TRACKING: 'resetTracking',
  UPDATE_SETTINGS: 'updateSettings'
};

document.addEventListener('DOMContentLoaded', async () => {
  localizeUI();
  await loadSettings();

  document.getElementById('api_mode').addEventListener('change', toggleModeUI);
  document.getElementById('save_settings').addEventListener('click', saveSettings);
  document.getElementById('reset_tracking').addEventListener('click', resetTracking);
  document.getElementById('refresh_models').addEventListener('click', () => fetchLocalModels(false));
  document.getElementById('unload_model').addEventListener('click', unloadLocalModel);
  
  toggleModeUI(); // Initial toggle
});

function localizeUI() {
  const elements = [
    { id: 'title_text', key: 'settingsTitle' },
    { id: 'api_mode_label', key: 'apiModeLabel' },
    { id: 'provider_label', key: 'apiProviderLabel' },
    { id: 'key_label', key: 'apiKeyLabel' },
    { id: 'local_type_label', key: 'localTypeLabel' },
    { id: 'local_port_label', key: 'localPortLabel' },
    { id: 'local_model_label', key: 'localModelLabel' },
    { id: 'duration_label', key: 'timerDurationLabel' },
    { id: 'save_settings', key: 'saveSettingsBtn' },
    { id: 'reset_tracking', key: 'resetTrackingBtn' },
    { id: 'refresh_models', key: 'refreshBtn' },
    { id: 'unload_model', key: 'unloadBtn' },
    { id: 'management_label', key: 'managementLabel' }
  ];

  elements.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (el) el.textContent = chrome.i18n.getMessage(key);
  });

  const apiModeEl = document.getElementById('api_mode');
  if (apiModeEl) {
    apiModeEl.options[0].textContent = chrome.i18n.getMessage("apiModePublic");
    apiModeEl.options[1].textContent = chrome.i18n.getMessage("apiModeLocal");
  }

  const apiKeyEl = document.getElementById('api_key');
  if (apiKeyEl) apiKeyEl.placeholder = chrome.i18n.getMessage("apiKeyPlaceholder");

  const localModelEl = document.getElementById('local_model');
  if (localModelEl) localModelEl.placeholder = chrome.i18n.getMessage("localModelPlaceholder");
}

async function toggleModeUI() {
  const mode = document.getElementById('api_mode').value;
  document.getElementById('public_settings').style.display = (mode === 'public') ? 'block' : 'none';
  document.getElementById('local_settings').style.display = (mode === 'local') ? 'block' : 'none';
  
  // Disable VRAM release when in public mode
  document.getElementById('unload_model').disabled = (mode === 'public');
  
  if (mode === 'local') {
    await fetchLocalModels();
  }
}

async function fetchLocalModels(silent = false) {
  const modelSelect = document.getElementById('local_model');
  const port = document.getElementById('local_port').value || "11435";
  const savedModel = modelSelect.dataset.savedValue; // Temp storage for initial load
  
  try {
    const response = await fetch(`http://localhost:${port}/api/tags`);
    if (!response.ok) throw new Error("Connection failed");
    
    const data = await response.json();
    modelSelect.innerHTML = "";
    
    if (data.models && data.models.length > 0) {
      data.models.forEach(m => {
        const option = document.createElement("option");
        option.value = m.name;
        option.textContent = m.name;
        modelSelect.appendChild(option);
      });
      
      // Restore saved value if it exists in the new list
      if (savedModel) {
        modelSelect.value = savedModel;
      }
      
      if (!silent) showStatus(chrome.i18n.getMessage("fetchModelsSuccess"), 'success');
    } else {
      showStatus(chrome.i18n.getMessage("noModelsFound"), 'error');
    }
  } catch (error) {
    console.error("Fetch models failed:", error);
    if (!silent) showStatus(chrome.i18n.getMessage("fetchModelsError"), 'error');
    
    // Add an error option if empty
    if (modelSelect.options.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "Error: Check Ollama";
      modelSelect.appendChild(option);
    }
  }
}

async function unloadLocalModel() {
  const model = document.getElementById('local_model').value;
  const port = document.getElementById('local_port').value || "11435";
  if (!model) return;

  try {
    const response = await fetch(`http://localhost:${port}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        keep_alive: 0
      })
    });

    if (response.ok) {
      showStatus(chrome.i18n.getMessage("unloadSuccess"), 'success');
    } else {
      throw new Error("Unload failed");
    }
  } catch (error) {
    console.error("Unload model failed:", error);
    showStatus(chrome.i18n.getMessage("unloadError"), 'error');
  }
}

async function loadSettings() {
  const result = await chrome.storage.sync.get([
    'api_mode', 'api_key', 'timer_duration', 'api_provider', 'local_type', 'local_port', 'local_model'
  ]);
  
  if (result.api_mode) document.getElementById('api_mode').value = result.api_mode;
  if (result.api_key) document.getElementById('api_key').value = result.api_key;
  if (result.timer_duration) document.getElementById('timer_duration').value = result.timer_duration;
  if (result.api_provider) document.getElementById('api_provider').value = result.api_provider;
  if (result.local_type) document.getElementById('local_type').value = result.local_type;
  if (result.local_port) document.getElementById('local_port').value = result.local_port;
  
  // Store saved model in dataset to be applied after fetch
  if (result.local_model) {
    document.getElementById('local_model').dataset.savedValue = result.local_model;
  }
}

async function saveSettings() {
  const apiMode = document.getElementById('api_mode').value;
  const apiKey = document.getElementById('api_key').value;
  const timerDuration = document.getElementById('timer_duration').value;
  const apiProvider = document.getElementById('api_provider').value;
  const localType = document.getElementById('local_type').value;
  const localPort = document.getElementById('local_port').value;
  const localModel = document.getElementById('local_model').value;
  
  try {
    const response = await chrome.runtime.sendMessage({
      action: ACTIONS.UPDATE_SETTINGS,
      api_mode: apiMode,
      api_key: apiKey,
      timer_duration: parseInt(timerDuration),
      api_provider: apiProvider,
      local_type: localType,
      local_port: parseInt(localPort || "11435"),
      local_model: localModel
    });

    if (response?.success) {
      showStatus(chrome.i18n.getMessage("settingsSaved"), 'success');
    }
  } catch (error) {
    showStatus(chrome.i18n.getMessage("saveFailed"), 'error');
  }
}

async function resetTracking() {
  if (!confirm(chrome.i18n.getMessage("resetConfirm"))) return;

  try {
    const response = await chrome.runtime.sendMessage({ action: ACTIONS.RESET_TRACKING });
    if (response?.success) {
      showStatus(chrome.i18n.getMessage("resetSuccess"), 'success');
    } else {
      showStatus(chrome.i18n.getMessage("resetFailed"), 'error');
    }
  } catch (error) {
    showStatus(chrome.i18n.getMessage("resetFailed"), 'error');
  }
}

function showStatus(text, type) {
  const statusEl = document.getElementById('status_message');
  statusEl.textContent = text;
  statusEl.className = 'status ' + type;
  statusEl.style.display = 'block';
  
  setTimeout(() => {
    statusEl.style.display = 'none';
  }, 3000);
}