# ADR 0306: Add selected transcript text to the conversation draft

- Status: Proposed
- Date: 2026-09-23
- Amends: ADR 0268, selection-overlay and quote removal only
- Related: issue #921

## Context

ADR 0268 removed a selection toolbar along with annotations and side chats.
That toolbar had several actions, a separate prompt serialization, and extra
session lifecycles. Users still need a direct way to reuse a sentence from a
conversation in their next prompt. Copying, moving to the composer, pasting,
and adding quote markers is unnecessarily slow for this single action.

## Decision

Selecting visible text inside one user message or assistant answer shows one
small action beside the selection: **Add to conversation**. It appends the
selected text as a line-by-line Markdown quote to the current session's
composer draft. A collapsed selection has no floating action; the speaking
turn's existing right-click menu also offers the action and falls back to the
whole turn. The action preserves the current draft and file references, focuses
the composer at the end, and never sends automatically.

The floating action belongs to the transcript scroller. It appears only after
selection within one speaking turn's body, stays in the viewport, and closes
when the selection clears, the user scrolls, the window resizes, or the pane
changes. It does not appear for tool output, thinking, the composer, or a
selection crossing turns. A pending insertion is discarded on session change.
The existing Copy action keeps its current behavior.

This is a renderer-only draft insertion. It does not restore the old Quote
action row, attribution metadata, annotation attachments, side chats, prompt
serialization, IPC, schema, or host changes. The retired decision and E2E IDs
in ADR 0268 remain retired.

## Consequences

The selected-text surface again requires selection ownership, placement, and
dismissal handling. One action and one session-scoped draft insertion keep that
cost bounded. A quote is ordinary editable composer text; the user decides
whether to send it.
