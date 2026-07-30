<script setup lang="ts">
import { withBase } from 'vitepress';
import { onUnmounted, ref } from 'vue';
import { createStore, segment } from '../../../src/core/index.ts';

const rowIds = ['alpha', 'beta', 'gamma'] as const;
type RowId = (typeof rowIds)[number];

const demo = createStore({
	rows: segment({ score: 0 }),
});

demo.state.rows.replaceAll({
	alpha: { score: 12 },
	beta: { score: 27 },
	gamma: { score: 41 },
});

const values = ref<Record<RowId, number>>({ alpha: 12, beta: 27, gamma: 41 });
const selected = ref<RowId>('beta');
const active = ref<RowId | null>(null);
const callbacks = ref<number | null>(null);
const elapsed = ref('—');
const lastPath = ref('rows/beta/score');
let callbackTotal = 0;
let pulseTimer: ReturnType<typeof setTimeout> | undefined;

const stops = rowIds.map((id) => {
	const score = demo.state.rows.at(id).score;
	return demo.observe(score, () => {
		callbackTotal += 1;
		values.value = { ...values.value, [id]: demo.get(score) };
	});
});

stops.push(
	demo.commits((commit) => {
		lastPath.value = commit.writes[0]?.path ?? lastPath.value;
	}),
);

function increment(id: RowId): void {
	selected.value = id;
	active.value = id;
	const beforeCallbacks = callbackTotal;
	const score = demo.state.rows.at(id).score;
	const started = performance.now();

	demo.update(score, (value) => value + 1, `hero/${id}/increment`);

	const duration = performance.now() - started;
	callbacks.value = callbackTotal - beforeCallbacks;
	elapsed.value = duration < 0.01 ? '<0.010 ms' : `${duration.toFixed(3)} ms`;

	if (pulseTimer) clearTimeout(pulseTimer);
	pulseTimer = setTimeout(() => {
		active.value = null;
	}, 420);
}

onUnmounted(() => {
	if (pulseTimer) clearTimeout(pulseTimer);
	for (const stop of stops) stop();
});
</script>

<template>
	<div class="live-state-demo">
		<header class="demo-header">
			<div class="demo-identity">
				<img :src="withBase('/logo-dark.svg')" alt="" />
				<div>
					<strong>Live store</strong>
					<span>running Segment core</span>
				</div>
			</div>
			<span class="live-indicator"><i></i> interactive</span>
		</header>

		<div class="demo-code" aria-label="Code executed by the demo">
			<div>
				<span class="line-no">1</span
				><code
					><b>const</b> score = s.rows.at(<em>'{{ selected }}'</em>).score</code
				>
			</div>
			<div><span class="line-no">2</span><code>store.observe(score, render)</code></div>
			<div><span class="line-no">3</span><code>store.update(score, n =&gt; n + 1)</code></div>
		</div>

		<div class="demo-state" aria-label="Live state values">
			<div
				v-for="id in rowIds"
				:key="id"
				class="state-row"
				:class="{ active: active === id, selected: selected === id }"
			>
				<div class="state-address">
					<span class="address-dot"></span>
					<code>rows/{{ id }}/score</code>
				</div>
				<strong>{{ values[id] }}</strong>
				<button type="button" :aria-label="`Increment ${id}`" @click="increment(id)">+1</button>
			</div>
		</div>

		<footer class="demo-result" aria-live="polite">
			<template v-if="callbacks === null">
				<span>Choose an address to commit</span>
				<code>{{ lastPath }}</code>
			</template>
			<template v-else>
				<span
					><b>{{ callbacks }}</b> callback</span
				>
				<span><b>0</b> selector runs</span>
				<span
					><b>{{ elapsed }}</b> commit</span
				>
			</template>
		</footer>
	</div>
</template>

<style scoped>
.live-state-demo {
	position: relative;
	z-index: 1;
	width: min(540px, 46vw);
	overflow: hidden;
	border: 1px solid rgba(244, 238, 232, 0.14);
	border-radius: 18px;
	background: radial-gradient(circle at 88% 0%, rgba(233, 8, 38, 0.14), transparent 34%), #11100f;
	box-shadow:
		0 28px 80px rgba(17, 16, 15, 0.32),
		0 0 0 1px rgba(17, 16, 15, 0.08);
	color: #f4eee8;
	text-align: left;
}

.demo-header,
.demo-result,
.state-row {
	display: flex;
	align-items: center;
}

.demo-header {
	justify-content: space-between;
	padding: 16px 18px;
	border-bottom: 1px solid rgba(244, 238, 232, 0.1);
}

.demo-identity {
	display: flex;
	align-items: center;
	gap: 10px;
}

.demo-identity img {
	width: 32px;
	height: 32px;
}

.demo-identity div {
	display: flex;
	flex-direction: column;
}

.demo-identity strong {
	font-size: 13px;
	line-height: 17px;
	letter-spacing: 0.02em;
	text-transform: uppercase;
}

.demo-identity span {
	color: #a89f97;
	font-size: 11px;
	line-height: 15px;
}

.live-indicator {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	border: 1px solid rgba(98, 211, 148, 0.22);
	border-radius: 999px;
	padding: 5px 9px;
	background: rgba(98, 211, 148, 0.08);
	color: #a6e9c4;
	font-size: 10px;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
}

.live-indicator i {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: #62d394;
	box-shadow: 0 0 12px #62d394;
}

.demo-code {
	padding: 14px 18px;
	border-bottom: 1px solid rgba(244, 238, 232, 0.1);
	background: rgba(0, 0, 0, 0.16);
}

.demo-code > div {
	display: flex;
	min-width: 0;
	line-height: 24px;
}

.demo-code code,
.state-address code,
.demo-result code {
	font-family: var(--vp-font-family-mono);
}

.demo-code code {
	overflow: hidden;
	color: #ddd6cf;
	font-size: 12px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.demo-code b {
	color: #ff6b7d;
	font-weight: 500;
}

.demo-code em {
	color: #9fc4ff;
	font-style: normal;
}

.line-no {
	flex: 0 0 22px;
	color: #5f5a55;
	font-family: var(--vp-font-family-mono);
	font-size: 10px;
}

.demo-state {
	display: grid;
	gap: 7px;
	padding: 14px 18px;
}

.state-row {
	position: relative;
	min-height: 42px;
	gap: 12px;
	overflow: hidden;
	border: 1px solid rgba(244, 238, 232, 0.09);
	border-radius: 9px;
	padding: 6px 7px 6px 12px;
	background: rgba(244, 238, 232, 0.035);
	transition:
		border-color 160ms ease,
		background 160ms ease,
		transform 160ms ease;
}

.state-row.selected {
	border-color: rgba(233, 8, 38, 0.34);
}

.state-row.active {
	border-color: rgba(255, 65, 90, 0.75);
	background: rgba(233, 8, 38, 0.12);
	transform: translateX(2px);
}

.state-address {
	display: flex;
	flex: 1;
	align-items: center;
	min-width: 0;
	gap: 9px;
}

.address-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: #665f59;
}

.selected .address-dot {
	background: #ff415a;
	box-shadow: 0 0 10px rgba(255, 65, 90, 0.7);
}

.state-address code {
	overflow: hidden;
	color: #bdb5ad;
	font-size: 11px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.state-row > strong {
	min-width: 24px;
	color: #fffaf5;
	font-family: var(--vp-font-family-mono);
	font-size: 13px;
	text-align: right;
}

.state-row button {
	width: 32px;
	height: 28px;
	border: 1px solid rgba(244, 238, 232, 0.13);
	border-radius: 7px;
	background: rgba(244, 238, 232, 0.07);
	color: #fffaf5;
	font: 700 12px/1 var(--vp-font-family-mono);
	cursor: pointer;
	transition:
		border-color 140ms ease,
		background 140ms ease;
}

.state-row button:hover,
.state-row button:focus-visible {
	border-color: #ff415a;
	background: rgba(233, 8, 38, 0.18);
	outline: none;
}

.demo-result {
	min-height: 48px;
	gap: 14px;
	padding: 11px 18px;
	border-top: 1px solid rgba(244, 238, 232, 0.1);
	background: rgba(0, 0, 0, 0.18);
	color: #a89f97;
	font-size: 10px;
}

.demo-result span {
	white-space: nowrap;
}

.demo-result b {
	color: #f4eee8;
	font-weight: 700;
}

.demo-result code {
	margin-left: auto;
	overflow: hidden;
	color: #ff6b7d;
	font-size: 10px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

@media (max-width: 959px) {
	.live-state-demo {
		width: min(540px, calc(100vw - 48px));
	}
}

@media (max-width: 480px) {
	.live-state-demo {
		border-radius: 14px;
	}

	.demo-header,
	.demo-code,
	.demo-state,
	.demo-result {
		padding-right: 14px;
		padding-left: 14px;
	}

	.demo-code code {
		font-size: 10px;
	}

	.demo-result {
		gap: 9px;
	}

	.demo-result span {
		font-size: 9px;
	}
}
</style>
