# LoongBoard PR workbench design QA

## Result

- No actionable P0, P1, or P2 differences remain in the requested Changes / Full File scope.
- LoongBoard intentionally keeps its own PR header, teal accent, and optional agent panel while adopting the requested GitHub file-review layout and VS Code file-state language.

## Visual sources

- GitHub live reference: `https://github.com/vllm-project/vllm/pull/53906/files`.
- GitHub capture: `design-qa/github-changes-reference-current.png`.
- User Changes reference: local temporary clipboard capture (not committed).
- User Full File reference: local temporary clipboard capture (not committed).
- User VS Code file-state reference: local temporary clipboard capture (not committed).
- Final implementation capture: `design-qa/changes-final-live.png`.
- Narrow Split regression capture: `design-qa/split-narrow-fixed-1353x987.jpg`.
- Same-input visual comparison: `design-qa/github-vs-loongboard-changes.png`.

The same-input comparison was reviewed at full resolution. It confirms the requested left file index, sticky per-file header, copy action beside the path, dominant code canvas, compact controls, and GitHub-like file card hierarchy. The implementation is denser because it preserves LoongBoard's full-height engineering workbench and uses the requested split view in the captured state.

## Browser acceptance

- `94` changed-file cards render in one continuous Changes document.
- With the pointer over Monaco code, a `720px` wheel gesture moved the outer `.pr-diff-main` by `720px`; Monaco did not create a second vertical scroll region.
- At outer scroll position `1820px`, the second file path `csrc/libtorch_stable/cache_kernels.cu` remained sticky at the top of the code viewport.
- The copy control is immediately adjacent to the sticky path; activation changed the visible state to `Copied`.
- Each file card collapses to its `47px` header and restores independently.
- With both side panels open and the code pane only `665px` wide, Split rendered `14` side-by-side Monaco diff editors with no inline fallback; Unified rendered the same mounted editors inline.
- Switching Unified → Split → Unified → Split preserved the selected layout, while a wheel gesture over Split code moved the single outer Changes scroller by `720px`.
- Both side panels fully unmounted when collapsed. Only one control per panel remains: a header Collapse control while open and a toolbar Expand control while closed.
- The left separator was dragged from `290px` to `350px`; its `aria-valuenow` and rendered width both updated to `350`.
- Full File switched the sidebar from `94` changed files to `6,890` files at the PR head.
- The repository tree showed `20` changed-ancestor folder dots, changed-file badges, and `8px` indentation steps.
- Opening unchanged `.clang-format` produced one normal full-file editor with zero inserted and zero removed decorations.
- A fresh reload after the final code change produced no new browser console errors. Earlier logged `cleanup.push` errors came from a superseded hot-reload build and did not recur after reload.

## Automated checks

- Web tests: `21` files, `107` tests passed.
- Contracts tests: `4` files, `28` tests passed.
- Git workspace tests: `3` files, `21` tests passed.
- Server diff route tests: `6` tests passed.
- Repository build: passed for all workspaces.
- ESLint, TypeScript, architecture boundaries, DSH release pin, and `git diff --check`: passed.
- The aggregate `pnpm check` reached the server suite with all `71` assertions passing, but Vitest returned failure because the concurrently running local preview exhausted macOS file watchers (`EMFILE`) in pre-existing knowledge watcher tests. The scoped server diff suite passed independently; this did not affect the requested feature acceptance.

## Acceptance checklist

- [x] One outer vertical scroll for all changed files.
- [x] Mouse-wheel scrolling works directly over code.
- [x] Sticky path and adjacent copy control for every file.
- [x] Per-file collapse and expand.
- [x] Unified and Split Changes modes.
- [x] Fully collapsible and draggable left/right panels.
- [x] Consistent Codicon panel controls with no collapsed rail.
- [x] Compact tree indentation.
- [x] Full File uses the complete repository tree.
- [x] VS Code-style changed files and ancestor folders.
- [x] Changed files keep diff context; unchanged files render as normal files.

## Issue detail header addendum (2026-09-08)

### Visual evidence

- Source visual truth: local temporary clipboard capture (not committed) (`1932 x 404`, desktop, light theme).
- Browser implementation: `design-qa/issue-header-final.png` (`1353 x 987`, CSS viewport `1353 x 987`, device scale factor `1`, vLLM Issue `#54521`, light theme).
- Focused same-input comparison: `design-qa/issue-header-reference-vs-final.png`. The reference was normalized to `1088 x 228`; the implementation header was cropped to `1088 x 210`. A focused comparison was required because the source contains only the header while the implementation capture includes the full application shell.

### Findings and comparison history

- Initial P2: the Issue number was separated into the eyebrow and a second `Open on GitHub` button duplicated the same destination. Fix: moved the number inline with the title, made the number the sole blue GitHub link, and removed the duplicate action. Post-fix evidence shows the GitHub-style title hierarchy, green status pill, compact metadata row, and only `Back to list` on the right.
- Fonts and typography: the implementation uses the product's existing sans-serif stack and compact dashboard scale while matching the source's medium-weight multiline title hierarchy.
- Spacing and layout rhythm: title, inline number, and status metadata follow the source order; the smaller vertical scale is intentional to preserve LoongBoard's surrounding navigation and content density.
- Colors and visual tokens: the Issue number uses GitHub link blue (`#0969da`), the open status uses the existing GitHub green token, and body text keeps LoongBoard's current light-theme contrast.
- Image quality and asset fidelity: the source contains no raster imagery or non-standard assets requiring generation; existing product icons remain unchanged.
- Copy and content: the available Issue title, number, author, timestamps, comment count, and status are preserved. The reference's linked pull-request badge is intentionally omitted because the current Issue contract does not provide linked-PR data.

### Browser acceptance

- Issue `#54521` number link resolves to `https://github.com/vllm-project/vllm/issues/54521`.
- No `Open on GitHub` action remains.
- `Back to list` resolves to `/repositories/vllm/issues`.
- The open status pill is present, and the rendered title wraps without clipping at `1353 x 987`.

### Automated checks

- Issue detail unit test: `1` test passed.
- Web TypeScript checks passed.
- `git diff --check` passed.

No actionable P0, P1, or P2 findings remain in the requested Issue-header scope.

final result: passed

## Merged page pagination addendum (2026-09-10)

## Comparison inputs

- Source reference: user-provided GitHub-style merged-list screenshot (`1092 x 600`, desktop, light theme).
- Implemented view: `http://127.0.0.1:5173/repositories/vllm-ascend/merged`
- Implementation capture: in-app browser CUA snapshots captured during this task at the current 1357 x 987 desktop viewport; the browser bridge does not persist its snapshot buffer as a workspace file.
- Theme and state: light theme, vLLM Ascend Merged page, page 1 and page 4.

## Comparison history

1. The baseline used a weak date label and thin divider, a generic check mark for every merged row, no merged count in the sidebar, and a separate load-more interaction.
2. The first implementation introduced shared indexed pagination, a merge icon, the sidebar count, and tinted date groups with a visible timeline.
3. The acceptance pass strengthened URL canonicalization, numeric substring search, narrow-screen wrapping, and the visual hierarchy of each date group.

## Final comparison

- Full view: date sections are now immediately distinguishable through a tinted bordered header, merge-node icon, count label, connected timeline, and a bordered list card.
- Focused component: row state uses the product's Codicon merge icon instead of a check mark; the same shared pagination renders page indexes, Previous/Next, ellipses, and an arbitrary-page input on PR and Merged pages.
- Data/UI consistency: the sidebar shows the exact Merged count and the page summary shows the visible item range and total.
- Interaction checks: direct navigation to Merged page 4 worked; stale PR/Merged cursor parameters were removed; Issues removed page parameters and retained cursor mode; numeric search `2026` matched titles and authors containing that continuous substring.
- Responsive check: the 390px rules now constrain root width, hide the secondary sync-status text, tighten the header, wrap metadata controls, and make page indexes horizontally scrollable within their own control instead of widening the page.
- No actionable P0, P1, or P2 visual finding remains in the requested flow. No visible application error boundary appeared during browser acceptance. The current browser bridge does not expose a console-log API, so console inspection was not claimed.

final result: passed
