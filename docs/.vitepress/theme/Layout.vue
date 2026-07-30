<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import LiveStateDemo from './LiveStateDemo.vue';
</script>

<template>
	<DefaultTheme.Layout>
		<template #home-hero-image>
			<LiveStateDemo />
		</template>
	</DefaultTheme.Layout>
</template>
