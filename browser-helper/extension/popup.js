document.querySelector('#activate').addEventListener('click', async () => {
  const button = document.querySelector('#activate');
  button.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    const local = ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.startsWith('/demo/') && url.protocol === 'http:';
    const schwab = url.hostname === 'client.schwab.com' && url.pathname === '/app/accounts/positions/' && url.protocol === 'https:';
    if (!local && !schwab) {
      throw new Error('Open Schwab Positions with one account selected, or the local pilot page.');
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    window.close();
  } catch (error) {
    document.querySelector('#status').textContent = error.message;
    button.disabled = false;
  }
});
