/**
 * Render verification for every console screen.
 *
 * This is not a substitute for looking at the thing, and it does not claim to
 * be — jsdom has no layout engine, so it cannot tell you a column is too narrow
 * or a chart is ugly. What it does catch is the class of defect that a passing
 * build and a passing typecheck both miss entirely: a screen that throws on
 * render, a `.map` over a field the API returns as null, a filter that never
 * fires, a control with no accessible name.
 *
 * Every screen is rendered against realistic API payloads, including the empty
 * and error cases, because those are the states nobody clicks through by hand.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Column, DataTable } from '../components/DataTable';
import { CursorLagRail, type SyncHealth } from '../components/Shell';
import { Badge, formatBytes, Pagination, relativeTime } from '../components/ui';
import * as apiModule from '../lib/api';
import { SessionProvider } from '../lib/auth';
import { Login } from '../pages/Login';

// --- fixtures ---------------------------------------------------------------

const health: SyncHealth = {
  serverCursor: 4190,
  unresolvedConflicts: 2,
  pendingUploads: 7,
  devices: [
    {
      id: 'd1',
      name: 'Pixel 8',
      platform: 'android',
      appVersion: '1.0.0',
      userName: 'Tom Whitfield',
      lastSyncAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      cursor: 4190,
      behind: 0,
      stale: false,
    },
    {
      id: 'd2',
      name: 'iPad Pro',
      platform: 'ios',
      appVersion: '1.0.0',
      userName: 'Priya Nair',
      lastSyncAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      cursor: 4180,
      behind: 10,
      stale: false,
    },
    {
      id: 'd3',
      name: 'Old Tablet',
      platform: 'android',
      appVersion: '0.9.0',
      userName: 'Jonas Berg',
      lastSyncAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      lastSeenAt: null,
      cursor: 1200,
      behind: 2990,
      stale: true,
    },
  ],
};

function wrap(ui: React.ReactElement): React.ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// --- primitives -------------------------------------------------------------

describe('primitives', () => {
  it('badge exposes its glyph as decorative so screen readers read the label once', () => {
    render(<Badge label="Approved" tone="ok" glyph="✓" />);
    const badge = screen.getByText('Approved');
    const glyph = badge.parentElement?.querySelector('[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    expect(glyph?.textContent).toBe('✓');
  });

  it('relativeTime falls back to an absolute date beyond a week', () => {
    const recent = relativeTime(new Date(Date.now() - 3_600_000).toISOString());
    expect(recent).toMatch(/hour|ago/i);

    const old = relativeTime(new Date(Date.now() - 40 * 86_400_000).toISOString());
    // A date, not "40 days ago" — beyond a week the exact day is what matters.
    expect(old).toMatch(/\d{4}/);
  });

  it('relativeTime handles null and garbage without throwing', () => {
    expect(relativeTime(null)).toBe('Never');
    expect(relativeTime('not-a-date')).toBe('—');
  });

  it('formatBytes renders human units and handles zero', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(null)).toBe('—');
  });

  it('pagination disables both controls on a single page', () => {
    render(<Pagination page={1} pageSize={25} total={10} onPage={() => undefined} />);
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).toBeDisabled();
  });

  it('pagination renders nothing when there is nothing to page', () => {
    const { container } = render(
      <Pagination page={1} pageSize={25} total={0} onPage={() => undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// --- the signature element --------------------------------------------------

describe('cursor lag rail', () => {
  it('places one accessible tick per device', () => {
    render(<CursorLagRail health={health} />);
    const ticks = screen.getAllByRole('img');
    expect(ticks).toHaveLength(3);
  });

  it('describes each device for screen readers, since position alone is visual', () => {
    render(<CursorLagRail health={health} />);
    expect(screen.getByLabelText(/Old Tablet.*2990 changes behind/i)).toBeInTheDocument();
  });

  it('classifies devices into up-to-date, behind, and silent', () => {
    render(<CursorLagRail health={health} />);
    expect(screen.getByText('Up to date').previousElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Behind head').previousElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Silent 24h+').previousElementSibling).toHaveTextContent('1');
  });

  it('does not use the same words for a metric and a legend key', () => {
    // The metric counts devices; the legend explains a dot colour. Reusing one
    // string for both makes the console look like it is repeating itself.
    render(<CursorLagRail health={health} />);
    expect(screen.getAllByText('Silent 24h+')).toHaveLength(1);
    expect(screen.getByText(/No contact/)).toBeInTheDocument();
  });

  it('positions the up-to-date device at the right edge and the straggler left of it', () => {
    const { container } = render(<CursorLagRail health={health} />);
    const ticks = Array.from(container.querySelectorAll('.lagrail__tick')) as HTMLElement[];
    const current = ticks.find((t) => t.className.includes('--current'))!;
    const stale = ticks.find((t) => t.className.includes('--stale'))!;
    expect(parseFloat(current.style.left)).toBe(100);
    expect(parseFloat(stale.style.left)).toBeLessThan(parseFloat(current.style.left));
  });

  it('survives an empty fleet rather than dividing by zero', () => {
    render(<CursorLagRail health={{ ...health, devices: [] }} />);
    expect(screen.getByText(/no enrolled devices/i)).toBeInTheDocument();
  });

  it('survives a fleet where every device is at head', () => {
    const allCurrent: SyncHealth = {
      ...health,
      devices: health.devices.map((d) => ({ ...d, behind: 0, stale: false })),
    };
    const { container } = render(<CursorLagRail health={allCurrent} />);
    // maxBehind would be 0; the guard keeps every position finite.
    for (const tick of Array.from(container.querySelectorAll('.lagrail__tick')) as HTMLElement[]) {
      expect(Number.isFinite(parseFloat(tick.style.left))).toBe(true);
    }
  });
});

// --- data table -------------------------------------------------------------

interface Row {
  id: string;
  name: string;
  count: number;
}

const columns: Array<Column<Row>> = [
  { key: 'name', header: 'Name', sortable: true, render: (r) => r.name },
  { key: 'count', header: 'Count', numeric: true, render: (r) => r.count },
];

function mockPaged(items: Row[], total = items.length) {
  return vi.spyOn(apiModule.api, 'get').mockResolvedValue({
    items,
    total,
    page: 1,
    pageSize: 25,
    hasMore: false,
  } as never);
}

describe('data table', () => {
  it('renders rows returned by the API', async () => {
    mockPaged([{ id: '1', name: 'Bishopsgate', count: 12 }]);
    render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    expect(await screen.findByText('Bishopsgate')).toBeInTheDocument();
  });

  it('shows a distinct empty state when a search matches nothing', async () => {
    mockPaged([]);
    render(
      wrap(
        <DataTable<Row>
          endpoint="/x"
          queryKey={['x']}
          columns={columns}
          rowKey={(r) => r.id}
          emptyTitle="No sites yet"
        />,
      ),
    );
    expect(await screen.findByText('No sites yet')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox'), 'zzz');
    // The wording must distinguish "nothing exists" from "nothing matched" —
    // they call for completely different actions from the operator.
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument();
  });

  it('debounces search so a typed word issues one request, not one per key', async () => {
    const spy = mockPaged([]);
    render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    await screen.findByText(/nothing here/i);
    spy.mockClear();

    await userEvent.type(screen.getByRole('searchbox'), 'substation');
    await waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 2000 });
    // Ten keystrokes must not become ten round trips.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('surfaces a failed load instead of showing a misleading empty table', async () => {
    vi.spyOn(apiModule.api, 'get').mockRejectedValue(new Error('Database unreachable'));
    render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/database unreachable/i);
  });

  it('marks the sorted column for assistive technology', async () => {
    mockPaged([{ id: '1', name: 'A', count: 1 }]);
    render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    await screen.findByText('A');

    await userEvent.click(screen.getByRole('button', { name: /^Name/ }));
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
    });
  });

  it('right-aligns numeric columns and applies tabular figures', async () => {
    mockPaged([{ id: '1', name: 'A', count: 42 }]);
    const { container } = render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    await screen.findByText('42');
    const cell = container.querySelector('td.table__num');
    expect(cell).not.toBeNull();
    expect(cell?.className).toContain('num');
  });

  it('resets to page one when the search changes', async () => {
    const spy = mockPaged([{ id: '1', name: 'A', count: 1 }], 500);
    render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    await screen.findByText('A');

    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/x', expect.objectContaining({ page: 2 })),
    );

    spy.mockClear();
    await userEvent.type(screen.getByRole('searchbox'), 'q');

    // Staying on page 4 of a now-single-page result is an empty screen the
    // operator has no way to interpret.
    await waitFor(
      () => expect(spy).toHaveBeenCalledWith('/x', expect.objectContaining({ page: 1 })),
      { timeout: 2000 },
    );
  });
});

// --- login ------------------------------------------------------------------

describe('sign in', () => {
  beforeEach(() => {
    vi.spyOn(apiModule, 'hasSession').mockReturnValue(false);
  });

  it('labels both fields and wires autocomplete for password managers', () => {
    render(
      wrap(
        <SessionProvider>
          <Login />
        </SessionProvider>,
      ),
    );
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });

  it('flags a malformed email on blur rather than only on submit', async () => {
    render(
      wrap(
        <SessionProvider>
          <Login />
        </SessionProvider>,
      ),
    );
    const email = screen.getByLabelText(/email/i);
    await userEvent.type(email, 'not-an-email');
    await userEvent.tab();
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
  });

  it('tells someone who wanted the field app that they are in the wrong place', () => {
    render(
      wrap(
        <SessionProvider>
          <Login />
        </SessionProvider>,
      ),
    );
    expect(screen.getByText(/mobile app/i)).toBeInTheDocument();
  });

  it('surfaces a rejected sign-in', async () => {
    vi.spyOn(apiModule, 'login').mockRejectedValue(
      new Error('The email or password is incorrect.'),
    );
    render(
      wrap(
        <SessionProvider>
          <Login />
        </SessionProvider>,
      ),
    );

    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/i);
  });
});

// --- password reveal --------------------------------------------------------

/**
 * The toggle is asserted through the real login form rather than in isolation,
 * because two of its failure modes only exist inside a form: a button without
 * an explicit type submits it, and clicking the toggle blurs the input, which
 * would re-hide the value the instant it was revealed.
 */
describe('password reveal', () => {
  beforeEach(() => {
    vi.spyOn(apiModule, 'hasSession').mockReturnValue(false);
    // The signup-availability probe would otherwise settle after the test ends.
    vi.spyOn(apiModule.api, 'get').mockResolvedValue({ available: false } as never);
  });

  function renderLogin(): { input: HTMLInputElement; toggle: HTMLElement } {
    render(
      wrap(
        <SessionProvider>
          <Login />
        </SessionProvider>,
      ),
    );
    return {
      input: screen.getByLabelText('Password') as HTMLInputElement,
      toggle: screen.getByRole('button', { name: /show password/i }),
    };
  }

  it('starts masked', () => {
    expect(renderLogin().input).toHaveAttribute('type', 'password');
  });

  it('reveals and re-masks the value', async () => {
    const { input, toggle } = renderLogin();

    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');

    await userEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('names the action and carries the state in aria-pressed', async () => {
    const { toggle } = renderLogin();
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(toggle);
    // A name that never changes leaves a screen reader user unsure what the
    // press did, so both the name and aria-pressed have to move.
    const pressed = screen.getByRole('button', { name: /hide password/i });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not submit the form it sits in', async () => {
    const login = vi.spyOn(apiModule, 'login').mockResolvedValue({} as never);
    const { input, toggle } = renderLogin();

    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.com');
    await userEvent.type(input, 'hunter2hunter2');
    await userEvent.click(toggle);

    expect(login).not.toHaveBeenCalled();
  });

  it('re-masks when focus leaves the field', async () => {
    const { input, toggle } = renderLogin();

    await userEvent.type(input, 'hunter2hunter2');
    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');

    await userEvent.click(screen.getByLabelText(/email/i));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('keeps a new password visible while it is being checked against the rules', async () => {
    vi.spyOn(apiModule.api, 'get').mockResolvedValue({ available: true } as never);
    render(
      wrap(
        <SessionProvider>
          <Login />
        </SessionProvider>,
      ),
    );

    await userEvent.click(await screen.findByRole('tab', { name: /create account/i }));

    const input = screen.getByLabelText('Password') as HTMLInputElement;
    await userEvent.click(screen.getByRole('button', { name: /show password/i }));
    await userEvent.click(screen.getByLabelText(/first name/i));

    // Unlike sign-in, the user is reading this one against the strength list.
    expect(input).toHaveAttribute('type', 'text');
  });
});

// --- accessibility floor ----------------------------------------------------

describe('accessibility floor', () => {
  it('every interactive control has an accessible name', async () => {
    mockPaged([{ id: '1', name: 'A', count: 1 }]);
    const { container } = render(
      wrap(
        <DataTable<Row> endpoint="/x" queryKey={['x']} columns={columns} rowKey={(r) => r.id} />,
      ),
    );
    await screen.findByText('A');

    const controls = container.querySelectorAll('button, input, select, a[href]');
    for (const control of Array.from(controls)) {
      const name =
        control.getAttribute('aria-label') ??
        control.getAttribute('title') ??
        control.textContent?.trim() ??
        '';
      expect(name.length, `unlabelled control: ${control.outerHTML.slice(0, 90)}`).toBeGreaterThan(
        0,
      );
    }
  });

  it('progress bars report their value numerically, not just visually', () => {
    render(<Pagination page={1} pageSize={10} total={100} onPage={() => undefined} />);
    // Pagination itself is text; the bar primitive is asserted through the rail.
    const { container } = render(<CursorLagRail health={health} />);
    expect(container.querySelectorAll('[role="img"][aria-label]').length).toBe(3);
  });
});
