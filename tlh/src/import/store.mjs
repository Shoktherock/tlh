import { emptyState, acceptPreview } from './engine.mjs';

let connection;
export function openStore() {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('tlh-import-pilot-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('portfolio');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Local storage is unavailable. No holdings were changed.'));
  });
  return connection;
}
export async function readState() {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('portfolio', 'readonly');
    const request = transaction.objectStore('portfolio').get('current');
    transaction.oncomplete = () => resolve(request.result ?? emptyState());
    transaction.onerror = () => reject(new Error('Could not read the local portfolio.'));
  });
}
export async function commitImport(preview, decision) {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('portfolio', 'readwrite');
    const store = transaction.objectStore('portfolio');
    const request = store.get('current');
    let outcome; let failure;
    request.onsuccess = () => {
      try {
        outcome = acceptPreview(request.result ?? emptyState(), preview, decision);
        if (!outcome.duplicate) store.put(outcome.state, 'current');
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(outcome);
    transaction.onabort = () => reject(failure ?? new Error('Acceptance failed; the local portfolio was not changed.'));
    transaction.onerror = () => { /* Abort reports one failure after IndexedDB rolls back. */ };
  });
}
