//! Pure keyword-heuristic tag classifier — no I/O. Matches a session's first user prompt
//! against the six-category taxonomy from SPEC.md line 104 (`feature`, `bugfix`, `refactor`,
//! `test`, `docs`, `infra`). A prompt can match zero, one, or multiple categories.

/// `(tag, keywords)` — keywords are matched case-insensitively as substrings of
/// `prompt_text`. Order doesn't affect the result (all matching categories are returned).
const CATEGORIES: &[(&str, &[&str])] = &[
    (
        "bugfix",
        &["fix", "bug", "broken", "error", "crash", "fails", "failing", "issue"],
    ),
    (
        "feature",
        &["add", "implement", "create", "build", "new feature", "new "],
    ),
    (
        "refactor",
        &["refactor", "cleanup", "clean up", "simplify", "reorganize", "restructure"],
    ),
    ("test", &["test", "spec", "coverage", "unit test"]),
    ("docs", &["document", "readme", "docs", "comment"]),
    (
        "infra",
        &["deploy", "ci", "docker", "config", "pipeline", "migration", "infra"],
    ),
];

/// Classifies `prompt_text` against the six-category tag taxonomy. Case-insensitive
/// substring matching against a small keyword list per category. Returns an empty `Vec` for
/// an empty string or a prompt matching no category. Never panics on empty, very long, or
/// non-ASCII input.
pub fn classify(prompt_text: &str) -> Vec<String> {
    let lower = prompt_text.to_lowercase();

    CATEGORIES
        .iter()
        .filter(|(_, keywords)| keywords.iter().any(|kw| lower.contains(kw)))
        .map(|(tag, _)| tag.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exactly_one_category() {
        let tags = classify("Please refactor the auth module for clarity.");
        assert_eq!(tags, vec!["refactor".to_string()]);
    }

    #[test]
    fn matches_multiple_categories() {
        let tags = classify("Fix the bug in the tests and add a new feature.");
        assert!(tags.contains(&"bugfix".to_string()));
        assert!(tags.contains(&"test".to_string()));
        assert!(tags.contains(&"feature".to_string()));
    }

    #[test]
    fn matches_no_category_returns_empty_vec() {
        let tags = classify("What's the weather like today?");
        assert!(tags.is_empty());
    }

    #[test]
    fn matching_is_case_insensitive() {
        let tags = classify("FIX the bug in main.rs");
        assert!(tags.contains(&"bugfix".to_string()));
    }

    #[test]
    fn empty_string_returns_empty_vec() {
        assert!(classify("").is_empty());
    }

    #[test]
    fn very_long_and_non_ascii_input_does_not_panic() {
        let long_prompt = format!("{} fix the crash 你好世界 🎉", "word ".repeat(10_000));
        let tags = classify(&long_prompt);
        assert!(tags.contains(&"bugfix".to_string()));
    }
}
