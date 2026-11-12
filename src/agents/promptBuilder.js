/**
 * Prompt-building helpers for Alice.
 *
 * These helpers keep untrusted/user-controlled text small, timestamped and
 * explicitly marked before it enters Claude's system prompt or message array.
 */

const PROMPT_MARKER_RE = /(^|\n)\s*(#{1,6}\s*|\[(?:SYSTEM|TOOL|CONTEXT|AI_SUMMARY|TRIGGER)[^\]]*\]\s*)/gi;

function cleanPromptText(value, maxLen = 1200) {
  const s = String(value ?? '')
    .replace(/\r/g, '\n')
    .replace(PROMPT_MARKER_RE, (m) => m.replace(/\[/g, '(').replace(/\]/g, ')').replace(/#/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[truncated]` : s;
}

function compactOneLine(value, maxLen = 240) {
  return cleanPromptText(value, maxLen).replace(/\s+/g, ' ').trim();
}

function isoOrNA(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'N/A' : d.toISOString();
}

function summarizePreferences(prefs, maxItems = 14) {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return 'none';
  const lines = [];
  const visit = (value, pathParts) => {
    if (lines.length >= maxItems || value == null) return;
    if (Array.isArray(value)) {
      const clean = value.map((v) => compactOneLine(v, 60)).filter(Boolean).slice(0, 8);
      if (clean.length) lines.push(`${pathParts.join('.')}: ${clean.join(', ')}`);
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, [...pathParts, k]);
      return;
    }
    const text = compactOneLine(value, 120);
    if (text) lines.push(`${pathParts.join('.')}: ${text}`);
  };
  visit(prefs, []);
  return lines.length ? lines.join(' | ') : 'none';
}

function summarizeConnectionReport(report) {
  const active = (report?.active_integrations || [])
    .map((c) => `${c.toolkit}:${c.state}`)
    .join(', ');
  const locked = (report?.locked_integrations || [])
    .map((c) => `${c.toolkit}:${c.state}`)
    .join(', ');
  return `active=${active || 'none'}; locked=${locked || 'none'}`;
}

function buildTimeAnchor({ activeTimezone = 'Europe/London', now = new Date() } = {}) {
  const d = now instanceof Date ? now : new Date(now);
  return {
    currentUtcTime: Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(),
    userTimezone: activeTimezone || 'Europe/London',
  };
}

module.exports = {
  PROMPT_MARKER_RE,
  cleanPromptText,
  compactOneLine,
  isoOrNA,
  summarizePreferences,
  summarizeConnectionReport,
  buildTimeAnchor,
};
