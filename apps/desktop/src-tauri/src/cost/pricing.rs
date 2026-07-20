//! Static, bundled per-model USD pricing table (`resources/pricing.json`), compiled into the
//! binary via `include_str!` — never read from disk at runtime, so it can't be edited/spoofed
//! by an agent. Parsed once and cached; lookups are defensive by design (never panic on an
//! unrecognized model string, a missing pricing entry, or malformed JSON), per PLAN.md §5's
//! "cost accuracy... resilient to unknown model values".

use serde::Deserialize;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

const PRICING_JSON: &str = include_str!("../../resources/pricing.json");

/// Sentinel key for the fallback rate applied to any model string that isn't an exact or
/// prefix match and isn't a `<...>` sentinel value.
const DEFAULT_KEY: &str = "_default";

/// Used only if `resources/pricing.json` somehow fails to parse (it's bundled and controlled
/// by us, so this should never happen in practice) — keeps lookups panic-free regardless.
const FALLBACK_DEFAULT_RATES: Rates = Rates {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3,
};

const ZERO_RATES: Rates = Rates {
    input: 0.0,
    output: 0.0,
    cache_write: 0.0,
    cache_read: 0.0,
};

#[derive(Debug, Clone, Copy, Deserialize)]
struct Rates {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

#[derive(Debug, Deserialize)]
struct PricingFile {
    #[allow(dead_code)] // parsed for completeness/future validation, not consulted at lookup time
    schema_version: u32,
    rates_per_million_tokens: HashMap<String, Rates>,
}

fn pricing_table() -> &'static HashMap<String, Rates> {
    static TABLE: OnceLock<HashMap<String, Rates>> = OnceLock::new();
    TABLE.get_or_init(|| match serde_json::from_str::<PricingFile>(PRICING_JSON) {
        Ok(file) => file.rates_per_million_tokens,
        Err(e) => {
            log::error!("failed to parse bundled pricing.json, falling back to built-in default rates only: {e}");
            let mut fallback = HashMap::new();
            fallback.insert(DEFAULT_KEY.to_string(), FALLBACK_DEFAULT_RATES);
            fallback
        }
    })
}

fn default_rates() -> &'static Rates {
    pricing_table()
        .get(DEFAULT_KEY)
        .unwrap_or(&FALLBACK_DEFAULT_RATES)
}

/// Longest-prefix match over every non-`_default` key in the pricing table — handles
/// versioned/dated suffixes on a known model family (e.g. a future
/// `claude-opus-4-8-20260115` matches the `claude-opus-4-8` entry).
fn longest_prefix_match<'a>(
    table: &'a HashMap<String, Rates>,
    model: &str,
) -> Option<&'a Rates> {
    table
        .iter()
        .filter(|(key, _)| key.as_str() != DEFAULT_KEY && model.starts_with(key.as_str()))
        .max_by_key(|(key, _)| key.len())
        .map(|(_, rates)| rates)
}

fn rates_for_model(model: &str) -> Rates {
    let table = pricing_table();

    // 1. Exact match.
    if let Some(r) = table.get(model) {
        return *r;
    }

    // 2. Longest-prefix match.
    if let Some(r) = longest_prefix_match(table, model) {
        return *r;
    }

    // 3. Sentinel: values like `<synthetic>` are non-billable placeholders seen in real logs
    //    — treat as zero cost, do NOT fall through to `_default`.
    if model.starts_with('<') {
        return ZERO_RATES;
    }

    // 4. Otherwise, `_default`, logging a one-time warning per unique unrecognized model.
    log_unknown_model_once(model);
    *default_rates()
}

fn log_unknown_model_once(model: &str) {
    static SEEN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let set = SEEN.get_or_init(|| Mutex::new(HashSet::new()));
    let mut set = set.lock().unwrap();
    if set.insert(model.to_string()) {
        log::warn!(
            "encountered unrecognized model string for pricing: {model:?} (falling back to _default rates)"
        );
    }
}

/// Finds the one key in the bundled pricing table whose name contains `"haiku"` — the single
/// source of truth for "which model string does the AI-summarization pipeline (Task C2) send
/// to the Anthropic API," per PLAN.md §6 ("from pricing.json"). Doesn't parse any new JSON —
/// just a lookup over the table already loaded by `pricing_table()`. Returns `None` (rather
/// than panicking or guessing) if no such key exists; the caller treats that the same as "no
/// API key" and skips summarization for this app run.
pub fn haiku_model_id() -> Option<&'static str> {
    pricing_table()
        .keys()
        .find(|k| k.contains("haiku"))
        .map(|k| k.as_str())
}

/// Computes the USD cost of a set of accumulated token totals for a session using the
/// bundled pricing table. `model: None` (no model seen yet) resolves to `_default` without
/// treating that as an error case. Never panics.
pub fn cost_usd(
    model: Option<&str>,
    prompt_tokens: i64,
    completion_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
) -> f64 {
    let rates = match model {
        None => *default_rates(),
        Some(m) => rates_for_model(m),
    };

    (prompt_tokens as f64 / 1e6) * rates.input
        + (completion_tokens as f64 / 1e6) * rates.output
        + (cache_creation_tokens as f64 / 1e6) * rates.cache_write
        + (cache_read_tokens as f64 / 1e6) * rates.cache_read
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_uses_the_named_models_rates() {
        // claude-opus-4-8: input 15.0, output 75.0, cache_write 18.75, cache_read 1.5
        // (per resources/pricing.json), against the known fixture token totals from
        // session_builder.rs's ingesting_fixture_accumulates_token_totals_and_model_on_the_session
        // test: 148 input / 700 output / 21800 cache_read / 290 cache_creation.
        let cost = cost_usd(Some("claude-opus-4-8"), 148, 700, 21800, 290);
        let expected = (148.0 / 1e6) * 15.0
            + (700.0 / 1e6) * 75.0
            + (290.0 / 1e6) * 18.75
            + (21800.0 / 1e6) * 1.5;
        assert!(
            (cost - expected).abs() < 1e-9,
            "expected {expected}, got {cost}"
        );
    }

    #[test]
    fn longest_prefix_match_resolves_a_dated_suffix_to_the_known_family_rate() {
        let dated = cost_usd(Some("claude-opus-4-8-20260115"), 148, 700, 21800, 290);
        let exact = cost_usd(Some("claude-opus-4-8"), 148, 700, 21800, 290);
        assert_eq!(dated, exact);
    }

    #[test]
    fn sentinel_model_is_non_billable_not_default() {
        // `<synthetic>` is a real sentinel value seen in Claude Code logs - must resolve to
        // exactly 0.0, not silently fall through to _default rates.
        let cost = cost_usd(Some("<synthetic>"), 1_000_000, 1_000_000, 1_000_000, 1_000_000);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn unrecognized_model_string_falls_back_to_default_rates() {
        let cost = cost_usd(Some("some-totally-unknown-future-model"), 1_000_000, 0, 0, 0);
        // _default input rate is 3.0 per resources/pricing.json.
        assert_eq!(cost, 3.0);
    }

    #[test]
    fn none_model_resolves_to_default_without_panicking() {
        let cost = cost_usd(None, 1_000_000, 0, 0, 0);
        assert_eq!(cost, 3.0);
    }

    #[test]
    fn zero_tokens_yields_zero_cost_regardless_of_model() {
        assert_eq!(cost_usd(Some("claude-opus-4-8"), 0, 0, 0, 0), 0.0);
        assert_eq!(cost_usd(None, 0, 0, 0, 0), 0.0);
    }

    #[test]
    fn haiku_model_id_finds_the_bundled_haiku_entry() {
        // resources/pricing.json currently bundles exactly one "*haiku*" key,
        // claude-haiku-4-5-20251001 — this pins that this task's summarization pipeline
        // resolves its model string from pricing.json rather than a second hardcoded literal.
        assert_eq!(haiku_model_id(), Some("claude-haiku-4-5-20251001"));
    }
}
