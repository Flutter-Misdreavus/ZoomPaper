const KEY = 'zoompaper.companion.enabled';
export const companionEnabled = () => localStorage.getItem(KEY) !== 'false';
export function setCompanionEnabled(enabled: boolean) {
  localStorage.setItem(KEY, String(enabled));
  window.dispatchEvent(new Event('companion-preference'));
}
