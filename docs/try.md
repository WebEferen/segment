---
title: Playground
description: Run Segment in the browser and inspect structural paths, commits, and live store statistics.
aside: false
---

<script setup lang="ts">
import { withBase } from 'vitepress';

const playgroundUrl = import.meta.env.DEV
	? 'https://webeferen.github.io/segment/playground/'
	: withBase('/playground/');
</script>

<div class="playground-page-header">
	<div>
		<p class="playground-eyebrow">Interactive example</p>
		<h1>Try Segment in the browser</h1>
		<p>
			Add, update, filter, and remove addressable records. The footer exposes the
			latest commit source and current number of materialized nodes.
		</p>
	</div>
	<a :href="playgroundUrl" target="_blank" rel="noreferrer">Open full screen ↗</a>
</div>

<div class="playground-frame-shell">
	<iframe
		class="playground-frame"
		:src="playgroundUrl"
		title="Interactive Segment playground"
		loading="eager"
	></iframe>
</div>

## What to try

- Toggle one todo and watch the commit source change to `todo/toggle`.
- Switch between `all`, `open`, and `done`; the filter is an ordinary typed cell.
- Add a todo; it receives its own structural address inside the `todos` segment.
- Remove records and observe that the state layer does not retain unused addresses.

The deployed application is built directly from the repository's
[`playground/`](https://github.com/WebEferen/segment/tree/main/playground) workspace
and shipped inside the same GitHub Pages artifact as these docs.
