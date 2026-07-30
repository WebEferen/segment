import { cell, createStore, segment } from '@webeferen/segment';
import './style.css';

type Filter = 'all' | 'open' | 'done';

const store = createStore({
	filter: cell<Filter>('all'),
	todos: segment<string>()({ title: '', completed: false }),
});
const s = store.state;

s.todos.replaceAll({
	architecture: { title: 'Keep the core framework-agnostic', completed: true },
	paths: { title: 'Address state by structural path', completed: false },
	performance: { title: 'Measure before optimizing', completed: false },
});

const app = document.querySelector<HTMLElement>('#app');
if (app === null) throw new Error('Missing #app');

let nextId = 1;
let lastCommit = 'replaceAll';

const escapeHtml = (value: string): string =>
	value.replace(
		/[&<>'"]/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!,
	);

function render(): void {
	const filter = store.get(s.filter);
	const todos = Object.entries(s.todos.snapshot());
	const visible = todos.filter(([, todo]) => {
		if (filter === 'open') return !todo.completed;
		if (filter === 'done') return todo.completed;
		return true;
	});
	const completed = todos.filter(([, todo]) => todo.completed).length;
	const stats = store.stats();

	app.innerHTML = `
		<section class="shell">
			<header>
				<div>
					<p class="eyebrow">@webeferen/segment</p>
					<h1>State you can address.</h1>
					<p class="intro">A framework-agnostic playground powered by structural paths and targeted subscriptions.</p>
				</div>
				<div class="pulse" aria-label="Store is live"><span></span> live store</div>
			</header>

			<form id="add-todo" class="composer">
				<input name="title" autocomplete="off" placeholder="Add a task…" aria-label="Task title" />
				<button type="submit">Add task</button>
			</form>

			<nav class="filters" aria-label="Filter tasks">
				${(['all', 'open', 'done'] as const)
					.map(
						(value) =>
							`<button data-filter="${value}" class="${filter === value ? 'active' : ''}">${value}</button>`,
					)
					.join('')}
			</nav>

			<ul class="todos">
				${
					visible
						.map(
							([id, todo]) => `
							<li class="${todo.completed ? 'completed' : ''}">
								<button class="check" data-toggle="${id}" aria-label="Toggle ${escapeHtml(todo.title)}">${todo.completed ? '✓' : ''}</button>
								<span>${escapeHtml(todo.title)}</span>
								<button class="remove" data-remove="${id}" aria-label="Remove ${escapeHtml(todo.title)}">×</button>
							</li>`,
						)
						.join('') || '<li class="empty">No tasks in this view.</li>'
				}
			</ul>

			<footer>
				<span><strong>${completed}</strong> / ${todos.length} completed</span>
				<span><strong>${stats.nodes}</strong> live nodes</span>
				<code>${escapeHtml(lastCommit)}</code>
			</footer>
		</section>`;
}

app.addEventListener('submit', (event) => {
	event.preventDefault();
	const form = event.target as HTMLFormElement;
	const data = new FormData(form);
	const title = String(data.get('title') ?? '').trim();
	if (title === '') return;
	store.patch(s.todos.at(`task-${nextId++}`), { title, completed: false }, 'todo/add');
	form.reset();
});

app.addEventListener('click', (event) => {
	const button = (event.target as Element).closest<HTMLButtonElement>('button');
	if (button === null) return;

	const filter = button.dataset.filter as Filter | undefined;
	if (filter !== undefined) {
		store.set(s.filter, filter, 'filter/change');
		return;
	}

	const toggle = button.dataset.toggle;
	if (toggle !== undefined) {
		store.update(s.todos.at(toggle).completed, (value) => !value, 'todo/toggle');
		return;
	}

	const remove = button.dataset.remove;
	if (remove !== undefined) {
		const next = { ...s.todos.snapshot() };
		delete next[remove];
		s.todos.replaceAll(next);
	}
});

store.commits((commit) => {
	lastCommit = commit.source;
	render();
});

render();
