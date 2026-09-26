/**
 * Structured JSON logging.
 *
 * One JSON object per line, which is what Railway's log viewer and every log
 * aggregator expect. Replaces the raw console.log calls in the prototype, whose
 * output could not be filtered by user, route or request.
 *
 * Usage:
 *   logger.info('user.created', { user_id });          // module-level
 *   req.log.warn('airtable.rate_limited', { status }); // carries request_id
 *
 * Every record carries: timestamp, level, event, and whatever context the caller
 * or the bound child adds. `event` is a dotted machine-readable name, not prose,
 * so logs can be grouped and alerted on.
 */

const SENSITIVE = /^(.*(password|secret|token|api_?key|authorization|auth_token).*)$/i;

/**
 * Replace credential-shaped values with a placeholder.
 *
 * Log lines are read by people and shipped to third-party aggregators, so a
 * payload that happens to contain a key should not become a permanent record of
 * that key. Matching is on the field name, which catches the realistic cases
 * without trying to guess whether an arbitrary string is a secret.
 */
function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // Only strings can carry a credential. Redacting booleans and numbers turns
    // deliberately safe diagnostics like `has_token: false` into noise.
    out[k] = typeof v === 'string' && SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, event, context = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redact(context),
  };

  // stderr for problems, stdout for everything else: standard stream semantics,
  // and it lets Railway's log filter separate them without parsing.
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/**
 * Build a logger whose every record carries `bound` context.
 * Used per-request so request_id and user_id do not have to be passed by hand.
 */
function createLogger(bound = {}) {
  const at = (level) => (event, context = {}) => emit(level, event, { ...bound, ...context });
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    /** Derive a further-bound child, e.g. after the user is identified. */
    child: (extra = {}) => createLogger({ ...bound, ...extra }),
    bindings: () => ({ ...bound }),
  };
}

module.exports = { logger: createLogger(), createLogger };
