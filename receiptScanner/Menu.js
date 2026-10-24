function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Receipt Scanner')
    .addItem('📱 Open Scanner Sidebar', 'showScannerSidebar')
    .addItem('Store Your API Key', 'promptForApiKey')
    .addToUi();
}

function showScannerSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Receipt Upload')
    .setWidth(320);
  SpreadsheetApp.getUi().showSidebar(html);
}

function promptForApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    '🔑 Setup Gemini API Key',
    'Please paste your free Gemini API key from Google AI Studio:\n(Get one at: https://aistudio.google.com/app/apikey)',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() === ui.Button.OK) {
    const apiKey = response.getResponseText().trim();
    if (apiKey) {
      PropertiesService.getUserProperties().setProperty('GEMINI_API_KEY', apiKey);
      ui.alert('✅ Success!', 'Your API key has been saved securely.', ui.ButtonSet.OK);
    } else {
      ui.alert('⚠️ Error', 'API key cannot be empty.', ui.ButtonSet.OK);
    }
  }
}

function getStoredApiKey() {
  let apiKey = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY');

  if (!apiKey) {
    promptForApiKey();
    apiKey = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY');
  }

  if (!apiKey) {
    throw new Error('Gemini API Key is missing. Please set it up via the Receipt Scanner menu.');
  }

  return apiKey;
}

function initializeDriveFolders() {
  const rootFolder = DriveApp.getRootFolder();
  const folders = {
    'Receipt Queue': null,
    'Processed Receipts': null
  };

  const it = rootFolder.getFolders();
  while (it.hasNext()) {
    const folder = it.next();
    if (folders.hasOwnProperty(folder.getName())) folders[folder.getName()] = folder.getId();
  }

  if (!folders['Receipt Queue']) {
    const folder = rootFolder.createFolder('Receipt Queue');
    folders['Receipt Queue'] = folder.getId();
  }
  if (!folders['Processed Receipts']) {
    const folder = rootFolder.createFolder('Processed Receipts');
    folders['Processed Receipts'] = folder.getId();
  }

  return folders;
}
