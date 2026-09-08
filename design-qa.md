# LoongBoard PR workbench design QA

## Result

- No actionable P0, P1, or P2 differences remain in the requested Changes / Full File scope.
- LoongBoard intentionally keeps its own PR header, teal accent, and optional agent panel while adopting the requested GitHub file-review layout and VS Code file-state language.

## Visual sources

- GitHub live reference: `https://github.com/vllm-project/vllm/pull/53906/files`.
- GitHub capture: `/Users/lonng/system/loong-dashboard/design-qa/github-changes-reference-current.png`.
- User Changes reference: `/var/folders/_x/r1dvxp_10bgdvbg2m73qt1hm0000gn/T/codex-clipboard-9dc86c49-a13f-4186-99f1-06caf536d6eb.png`.
- User Full File reference: `/var/folders/_x/r1dvxp_10bgdvbg2m73qt1hm0000gn/T/codex-clipboard-c70ceea0-852f-4b49-bf41-e72ce10327be.png`.
- User VS Code file-state reference: `/var/folders/_x/r1dvxp_10bgdvbg2m73qt1hm0000gn/T/codex-clipboard-e73fd185-65da-4c8d-8e09-f85cc5c0d6d5.png`.
- Final implementation capture: `/Users/lonng/system/loong-dashboard/design-qa/changes-final-live.png`.
- Narrow Split regression capture: `/Users/lonng/system/loong-dashboard/design-qa/split-narrow-fixed-1353x987.jpg`.
- Same-input visual comparison: `/Users/lonng/system/loong-dashboard/design-qa/github-vs-loongboard-changes.png`.

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

- Source visual truth: `/var/folders/_x/r1dvxp_10bgdvbg2m73qt1hm0000gn/T/codex-clipboard-8d6b847e-a8dd-4404-810c-fba1be8c71cf.png` (`1932 x 404`, desktop, light theme).
- Browser implementation: `/Users/lonng/system/loong-dashboard/design-qa/issue-header-final.png` (`1353 x 987`, CSS viewport `1353 x 987`, device scale factor `1`, vLLM Issue `#54521`, light theme).
- Focused same-input comparison: `/Users/lonng/system/loong-dashboard/design-qa/issue-header-reference-vs-final.png`. The reference was normalized to `1088 x 228`; the implementation header was cropped to `1088 x 210`. A focused comparison was required because the source contains only the header while the implementation capture includes the full application shell.

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
