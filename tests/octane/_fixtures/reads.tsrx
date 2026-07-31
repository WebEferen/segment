import { useValue } from 'segment-state';
import type { AppStore } from './store.js';

interface Props {
	app: AppStore;
	renders: { cell: number; branch: number; derived: number };
}

export function CellReader({ app, renders }: Props) @{
	const [theme] = useValue(app.s.ui.theme);
	renders.cell++;
	<p id="cell">{theme as string}</p>
}

export function DerivedReader({ app, renders }: Props) @{
	const [doubled] = useValue(app.s.totals.doubled);
	renders.derived++;
	<p id="derived">{doubled as string}</p>
}

/**
 * A branch read returns the record AS STORED, so a key nothing has written reads
 * as undefined rather than as an object of defaults. Per-field defaults are a
 * leaf-read guarantee; synthesizing them here would allocate on every read and
 * would still not fill a partially written record.
 *
 * Writes go through to the bulk value IN PLACE, so this object's identity never
 * changes — the adapter has to gate on `revision` for this to update at all.
 */
export function BranchReader({ app, renders }: Props) @{
	const [user] = useValue(app.s.users.at('u1'));
	renders.branch++;
	<p id="branch">{(user === undefined ? 'absent' : `${user.name}/${user.age}`) as string}</p>
}

export function Reads({ app, renders }: Props) @{
	<div>
		<CellReader app={app} renders={renders} />
		<DerivedReader app={app} renders={renders} />
		<BranchReader app={app} renders={renders} />
	</div>
}
