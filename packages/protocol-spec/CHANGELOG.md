# Changelog

All notable changes to the Dispatch Messaging Protocol. Entries are tagged
`[editorial]`, `[clarification]`, `[additive]` or `[breaking]` and name their
vector ids (see §14.2).

## Unreleased

- [editorial] The core text: §0-7, §9-14.
- [clarification] §4.6 rewrites an ended session among a reply target's `to`
  addresses as it does the target's sender, and §6.1 refuses a human's wake
  request naming a session that stands for no work item:
  `core.answers.a-reply-to-an-ended-recipient-goes-to-its-work-item`,
  `core.answers.a-reply-to-an-ended-recipient-reaches-the-successor-session`,
  `core.answers.a-reply-naming-an-ended-session-its-target-never-reached-fails`,
  `core.wake.a-humans-wake-to-a-session-of-no-work-item-fails`.
