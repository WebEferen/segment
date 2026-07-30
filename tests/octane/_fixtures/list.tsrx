import { useValue } from '@webeferen/segment/octane';
import type { AppStore } from './store.js';

interface Props {
	app: AppStore;
	ids: string[];
	renders: Record<string, number>;
}

/**
 * One `useValue` per keyed item. Each item body is its own block, so a write to
 * one key must wake exactly one row — this fixture exists to observe that.
 */
export function Rows({ app, ids, renders }: Props) @{
	<ul id="rows">
		@for (const id of ids; key id) {
			<Row app={app} id={id} renders={renders} />
		}
	</ul>
}

function Row({
	app,
	id,
	renders,
}: {
	app: AppStore;
	id: string;
	renders: Record<string, number>;
}) @{
	const [name] = useValue(app.s.users.at(id).name);
	renders[id] = (renders[id] ?? 0) + 1;
	<li class="row" data-id={id}>{name as string}</li>
}
