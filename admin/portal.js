const state = {
    supabase: null,
    session: null,
    waitlist: [],
    contributions: [],
    verifiedUsers: [],
    admins: [],
    filters: {
        interest: 'all',
        waitlistSearch: '',
        tier: 'all',
        contribSearch: '',
        status: 'all',
        userSearch: ''
    },
    metrics: {
        waiting: 0,
        solRaised: 0,
        verified: 0,
        admins: 0
    },
    backups: [],
    lastSystemCheck: null
};

const refs = {
    guard: document.getElementById('auth-guard'),
    app: document.getElementById('admin-app'),
    waitlistBody: document.getElementById('waitlist-body'),
    contribBody: document.getElementById('contrib-body'),
    usersBody: document.getElementById('users-body'),
    adminBody: document.getElementById('adminlist-body'),
    statWaiting: document.getElementById('stat-waiting'),
    statSol: document.getElementById('stat-sol'),
    statVerified: document.getElementById('stat-verified'),
    statAdmins: document.getElementById('stat-admins'),
    statAvg: document.getElementById('stat-avg'),
    statMax: document.getElementById('stat-max'),
    statCount: document.getElementById('stat-count'),
    statusApi: document.getElementById('status-api'),
    statusApiMeta: document.getElementById('status-api-meta'),
    statusDb: document.getElementById('status-db'),
    statusDbMeta: document.getElementById('status-db-meta'),
    statusBackup: document.getElementById('status-backup'),
    activityFeed: document.getElementById('activity-feed'),
    adminEmail: document.getElementById('admin-email'),
    toastBox: document.getElementById('toast-box')
};

const SUPABASE_URL = 'https://leasiwevraqnkcsjqasd.supabase.co';
const SUPABASE_FUN_URL = `${SUPABASE_URL}/functions/v1`;
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxlYXNpd2V2cmFxbmtjc2pxYXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1OTgxOTgsImV4cCI6MjA4NzE3NDE5OH0.eSLIWTwV7NiI0I7xmPXxR5vVwLTLbHzPdtiWDnaGOo8';

init();

async function init() {
    try {
        const client = await waitForSupabase();
        state.supabase = client;
        const session = await requireSession(client);
        state.session = session;
        refs.adminEmail.textContent = session.user?.email || session.user?.user_metadata?.email || 'Admin';
        await verifyAdmin(client, session.user.id);
        hydrateLocalBackups();
        attachEvents();
        toggleGuard(false);
        await refreshAll();
    } catch (error) {
        console.error('Admin portal init failed', error);
        alert('Admin access required. Redirecting to dashboard.');
        window.location.href = '../index.html';
    }
}

function attachEvents() {
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('refresh-all').addEventListener('click', refreshAll);
    document.getElementById('activity-refresh').addEventListener('click', buildActivityFeed);
    document.getElementById('status-refresh').addEventListener('click', refreshSystemStatus);
    document.getElementById('waitlist-export').addEventListener('click', () => exportWaitlist(state.waitlist));
    document.getElementById('contrib-export').addEventListener('click', () => exportContributions(state.contributions));
    document.getElementById('users-refresh').addEventListener('click', () => loadUsers(true));
    document.getElementById('waitlist-refresh').addEventListener('click', () => loadWaitlist(true));
    document.getElementById('contrib-refresh').addEventListener('click', () => loadContributions(true));
    document.getElementById('adminlist-refresh').addEventListener('click', () => loadAdmins(true));

    document.getElementById('filter-interest').addEventListener('change', (e) => {
        state.filters.interest = e.target.value;
        renderWaitlist();
    });
    document.getElementById('search-waitlist').addEventListener('input', debounce((e) => {
        state.filters.waitlistSearch = e.target.value.toLowerCase();
        renderWaitlist();
    }, 200));
    document.getElementById('filter-tier').addEventListener('change', (e) => {
        state.filters.tier = e.target.value;
        renderContributions();
    });
    document.getElementById('search-contrib').addEventListener('input', debounce((e) => {
        state.filters.contribSearch = e.target.value.toLowerCase();
        renderContributions();
    }, 200));
    document.getElementById('filter-status').addEventListener('change', (e) => {
        state.filters.status = e.target.value;
        renderUsers();
    });
    document.getElementById('search-users').addEventListener('input', debounce((e) => {
        state.filters.userSearch = e.target.value.toLowerCase();
        renderUsers();
    }, 200));

    document.getElementById('add-admin').addEventListener('click', addAdmin);

    document.getElementById('backup-save').addEventListener('click', saveBackupEntry);
    document.getElementById('export-waiting-lite').addEventListener('click', () => exportWaitlist(state.waitlist, true));
    document.getElementById('export-contrib-lite').addEventListener('click', () => exportContributions(state.contributions, true));
    document.getElementById('export-users-lite').addEventListener('click', () => exportUsers(state.verifiedUsers));

    setupNavigation();
}

function setupNavigation() {
    const navLinks = Array.from(document.querySelectorAll('[data-nav]'));
    navLinks.forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = link.getAttribute('href').replace('#', '');
            const section = document.getElementById(targetId);
            if (section) {
                window.scrollTo({ top: section.offsetTop - 20, behavior: 'smooth' });
                setActiveNav(link);
            }
        });
    });
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                const id = entry.target.getAttribute('id');
                const link = navLinks.find((lnk) => lnk.getAttribute('href') === `#${id}`);
                if (link) {
                    setActiveNav(link);
                }
            }
        });
    }, { rootMargin: '-50% 0px -40% 0px' });
    document.querySelectorAll('.section').forEach((section) => observer.observe(section));
}

function setActiveNav(activeLink) {
    document.querySelectorAll('[data-nav]').forEach((link) => {
        link.classList.toggle('active', link === activeLink);
    });
}

async function waitForSupabase(retries = 40, delay = 150) {
    while (retries > 0) {
        if (window.supabaseClient) {
            return window.supabaseClient;
        }
        await sleep(delay);
        retries--;
    }
    throw new Error('Supabase client unavailable');
}

async function requireSession(client) {
    const { data, error } = await client.auth.getSession();
    if (error || !data?.session) {
        throw new Error('Session required');
    }
    return data.session;
}

async function verifyAdmin(client, userId) {
    const { data, error } = await client
        .from('admin_users')
        .select('id')
        .eq('id', userId)
        .maybeSingle();
    if (error || !data) {
        throw new Error('Not authorized');
    }
}

function toggleGuard(show) {
    if (show) {
        refs.guard.classList.remove('hidden');
        refs.app.classList.add('hidden');
    } else {
        refs.guard.classList.add('hidden');
        refs.app.classList.remove('hidden');
    }
}

async function refreshAll() {
    try {
        setTableLoading(refs.waitlistBody, 7);
        setTableLoading(refs.contribBody, 7);
        setTableLoading(refs.usersBody, 6);
        setTableLoading(refs.adminBody, 4);
        await Promise.all([
            loadWaitlist(),
            loadContributions(),
            loadUsers(),
            loadAdmins(),
            refreshSystemStatus()
        ]);
        buildActivityFeed();
    } catch (error) {
        console.error('Refresh failed', error);
        toast('Refresh failed: ' + error.message, 'error');
    }
}

async function loadWaitlist(force = false) {
    if (!force && state.waitlist.length) return;
    const { data, error } = await state.supabase
        .from('waiting_list')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        console.error('Waiting list error', error);
        refs.waitlistBody.innerHTML = `<tr><td colspan="7" style="padding:18px;color:var(--muted);">${error.message}</td></tr>`;
        return;
    }
    state.waitlist = data || [];
    state.metrics.waiting = state.waitlist.length;
    renderWaitlist();
    renderStats();
}

function renderWaitlist() {
    if (!refs.waitlistBody) return;
    const { interest, waitlistSearch } = state.filters;
    let rows = [...state.waitlist];
    if (interest !== 'all') {
        rows = rows.filter((row) => (row.interest_level || 'unknown') === interest);
    }
    if (waitlistSearch) {
        rows = rows.filter((row) => {
            const target = `${row.email || ''} ${row.wallet_address || row.wallet || ''} ${row.telegram_handle || ''}`.toLowerCase();
            return target.includes(waitlistSearch);
        });
    }
    if (!rows.length) {
        refs.waitlistBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:18px;">No waiting list entries match the filters.</td></tr>';
        return;
    }
    refs.waitlistBody.innerHTML = rows.map((entry) => {
        const notified = Boolean(entry.notified);
        return `<tr>
            <td>${entry.email || '—'}</td>
            <td>${formatWallet(entry.wallet_address || entry.wallet)}</td>
            <td>${entry.telegram_handle || '—'}</td>
            <td><span class="badge badge-neutral">${(entry.interest_level || 'unknown').toUpperCase()}</span></td>
            <td>${formatDate(entry.created_at)}</td>
            <td>
                <label class="toggle">
                    <input type="checkbox" ${notified ? 'checked' : ''} data-notified="${entry.id}">
                    <span></span>
                </label>
            </td>
            <td style="display:flex;gap:6px;">
                <button class="btn btn-ghost btn-sm" data-action="notify" data-id="${entry.id}">${notified ? 'Mark Unsent' : 'Mark Notified'}</button>
                <button class="btn btn-danger btn-sm" data-action="delete-wait" data-id="${entry.id}">Delete</button>
            </td>
        </tr>`;
    }).join('');
    refs.waitlistBody.querySelectorAll('button[data-action="notify"]').forEach((btn) => {
        btn.addEventListener('click', () => toggleWaitlistNotify(btn.dataset.id));
    });
    refs.waitlistBody.querySelectorAll('button[data-action="delete-wait"]').forEach((btn) => {
        btn.addEventListener('click', () => deleteWaitlistEntry(btn.dataset.id));
    });
    refs.waitlistBody.querySelectorAll('input[data-notified]').forEach((input) => {
        input.addEventListener('change', () => toggleWaitlistNotify(input.dataset.notified));
    });
}

async function toggleWaitlistNotify(id) {
    const entry = state.waitlist.find((row) => row.id === id);
    if (!entry) return;
    const next = !entry.notified;
    const { error } = await state.supabase
        .from('waiting_list')
        .update({ notified: next })
        .eq('id', id);
    if (error) {
        console.error('Notify update failed', error);
        toast('Failed to update entry', 'error');
        return;
    }
    entry.notified = next;
    renderWaitlist();
    toast(`Marked as ${next ? 'notified' : 'pending'}`, 'success');
}

async function deleteWaitlistEntry(id) {
    if (!confirm('Delete this waiting list entry?')) return;
    const { error } = await state.supabase
        .from('waiting_list')
        .delete()
        .eq('id', id);
    if (error) {
        console.error('Delete error', error);
        toast('Delete failed: ' + error.message, 'error');
        return;
    }
    state.waitlist = state.waitlist.filter((row) => row.id !== id);
    renderWaitlist();
    state.metrics.waiting = state.waitlist.length;
    renderStats();
    toast('Entry deleted', 'success');
}

async function loadContributions(force = false) {
    if (!force && state.contributions.length) return;
    const { data, error } = await state.supabase
        .from('presale_contributions')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        refs.contribBody.innerHTML = `<tr><td colspan="7" style="padding:18px;color:var(--muted);">${error.message}</td></tr>`;
        return;
    }
    state.contributions = data || [];
    updateContributionFilters();
    computeContributionStats();
    renderContributions();
}

function renderContributions() {
    if (!refs.contribBody) return;
    const { tier, contribSearch } = state.filters;
    let rows = [...state.contributions];
    if (tier !== 'all') {
        rows = rows.filter((row) => (row.tier_name || `Tier ${row.tier_id || ''}`) === tier);
    }
    if (contribSearch) {
        rows = rows.filter((row) => {
            const target = `${row.wallet_address || ''} ${row.transaction_signature || ''}`.toLowerCase();
            return target.includes(contribSearch);
        });
    }
    if (!rows.length) {
        refs.contribBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:18px;">No contributions found for the selected filters.</td></tr>';
        return;
    }
    refs.contribBody.innerHTML = rows.map((entry) => {
        const tierLabel = entry.tier_name || (entry.tier_id ? `Tier ${entry.tier_id}` : '—');
        const sol = Number(entry.sol_amount || entry.sol || 0);
        const tokens = Number(entry.token_amount || entry.tokens || 0);
        return `<tr>
            <td>${formatWallet(entry.wallet_address)}</td>
            <td>${tierLabel}</td>
            <td>${sol.toFixed(2)}</td>
            <td>${formatNumber(tokens)}</td>
            <td>${entry.bonus_percentage || 0}%</td>
            <td>${formatDate(entry.created_at)}</td>
            <td><a href="https://explorer.solana.com/tx/${entry.transaction_signature}?cluster=devnet" target="_blank">View ↗</a></td>
        </tr>`;
    }).join('');
}

function computeContributionStats() {
    const list = state.contributions;
    if (!list.length) {
        refs.statSol.textContent = '0';
        refs.statAvg.textContent = '0';
        refs.statMax.textContent = '0';
        refs.statCount.textContent = '0';
        state.metrics.solRaised = 0;
        renderStats();
        return;
    }
    const totals = list.map((row) => Number(row.sol_amount || 0));
    const sum = totals.reduce((acc, val) => acc + val, 0);
    const avg = sum / totals.length;
    const max = Math.max(...totals);
    refs.statSol.textContent = sum.toFixed(2);
    refs.statAvg.textContent = avg.toFixed(2);
    refs.statMax.textContent = max.toFixed(2);
    refs.statCount.textContent = totals.length.toString();
    state.metrics.solRaised = sum;
    renderStats();
}

async function loadUsers(force = false) {
    if (!force && state.verifiedUsers.length) return;
    const { data, error } = await state.supabase
        .from('community_verification')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        refs.usersBody.innerHTML = `<tr><td colspan="6" style="padding:18px;color:var(--muted);">${error.message}</td></tr>`;
        return;
    }
    state.verifiedUsers = data || [];
    state.metrics.verified = state.verifiedUsers.filter((row) => row.verification_status === 'verified').length;
    renderUsers();
    renderStats();
}

function renderUsers() {
    if (!refs.usersBody) return;
    const { status, userSearch } = state.filters;
    let rows = [...state.verifiedUsers];
    if (status !== 'all') rows = rows.filter((row) => (row.verification_status || 'pending') === status);
    if (userSearch) {
        rows = rows.filter((row) => {
            const target = `${row.wallet_address || ''} ${row.twitter_handle || ''} ${row.telegram_handle || ''}`.toLowerCase();
            return target.includes(userSearch);
        });
    }
    if (!rows.length) {
        refs.usersBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:18px;">No users match the filters.</td></tr>';
        return;
    }
    refs.usersBody.innerHTML = rows.map((user) => {
        const statusBadge = buildStatusBadge(user.verification_status);
        return `<tr>
            <td>${formatWallet(user.wallet_address)}</td>
            <td>${user.twitter_handle || '—'}</td>
            <td>${user.telegram_handle || '—'}</td>
            <td>${statusBadge}</td>
            <td>${formatDate(user.created_at)}</td>
            <td style="display:flex;gap:6px;">
                <button class="btn btn-ghost btn-sm" data-action="approve" data-id="${user.id}">Approve</button>
                <button class="btn btn-ghost btn-sm" data-action="reject" data-id="${user.id}">Reject</button>
            </td>
        </tr>`;
    }).join('');
    refs.usersBody.querySelectorAll('button[data-action="approve"]').forEach((btn) => btn.addEventListener('click', () => updateVerificationStatus(btn.dataset.id, 'verified')));
    refs.usersBody.querySelectorAll('button[data-action="reject"]').forEach((btn) => btn.addEventListener('click', () => updateVerificationStatus(btn.dataset.id, 'rejected')));
}

function buildStatusBadge(status = 'pending') {
    switch (status) {
        case 'verified':
            return '<span class="badge badge-success">Verified</span>';
        case 'rejected':
            return '<span class="badge badge-error">Rejected</span>';
        default:
            return '<span class="badge badge-neutral">Pending</span>';
    }
}

async function updateVerificationStatus(id, status) {
    const { error } = await state.supabase
        .from('community_verification')
        .update({ verification_status: status })
        .eq('id', id);
    if (error) {
        toast('Failed to update status: ' + error.message, 'error');
        return;
    }
    const target = state.verifiedUsers.find((row) => row.id === id);
    if (target) target.verification_status = status;
    renderUsers();
    state.metrics.verified = state.verifiedUsers.filter((row) => row.verification_status === 'verified').length;
    renderStats();
    toast('Status updated', 'success');
}

async function loadAdmins(force = false) {
    if (!force && state.admins.length) return;
    const { data, error } = await state.supabase
        .from('admin_users')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        refs.adminBody.innerHTML = `<tr><td colspan="4" style="padding:18px;color:var(--muted);">${error.message}</td></tr>`;
        return;
    }
    state.admins = data || [];
    state.metrics.admins = state.admins.length;
    renderAdmins();
    renderStats();
}

function renderAdmins() {
    if (!refs.adminBody) return;
    if (!state.admins.length) {
        refs.adminBody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px;">No admin accounts configured.</td></tr>';
        return;
    }
    refs.adminBody.innerHTML = state.admins.map((admin) => {
        return `<tr>
            <td>${admin.email || '—'}</td>
            <td style="font-size:0.82rem;color:var(--muted);">${admin.id}</td>
            <td>${admin.role || 'admin'}</td>
            <td>
                <label class="toggle">
                    <input type="checkbox" checked data-admin="${admin.id}">
                    <span></span>
                </label>
            </td>
        </tr>`;
    }).join('');
    refs.adminBody.querySelectorAll('input[data-admin]').forEach((toggle) => {
        toggle.addEventListener('change', () => {
            if (!toggle.checked) {
                removeAdmin(toggle.dataset.admin);
            } else {
                // Re-enable if toggled accidentally
                toggle.checked = true;
            }
        });
    });
}

async function addAdmin() {
    const idInput = document.getElementById('new-admin-id');
    const emailInput = document.getElementById('new-admin-email');
    const adminId = idInput.value.trim();
    const email = emailInput.value.trim();
    if (!adminId || !email) {
        toast('Provide both user ID and email.', 'error');
        return;
    }
    const { error } = await state.supabase
        .from('admin_users')
        .insert({ id: adminId, email });
    if (error) {
        toast('Failed to add admin: ' + error.message, 'error');
        return;
    }
    idInput.value = '';
    emailInput.value = '';
    await loadAdmins(true);
    toast('Admin added', 'success');
}

async function removeAdmin(adminId) {
    if (!confirm('Remove this admin?')) {
        renderAdmins();
        return;
    }
    const { error } = await state.supabase
        .from('admin_users')
        .delete()
        .eq('id', adminId);
    if (error) {
        toast('Failed to remove admin: ' + error.message, 'error');
        renderAdmins();
        return;
    }
    state.admins = state.admins.filter((row) => row.id !== adminId);
    state.metrics.admins = state.admins.length;
    renderAdmins();
    renderStats();
    toast('Admin removed', 'success');
}

function renderStats() {
    refs.statWaiting.textContent = state.metrics.waiting.toString();
    refs.statSol.textContent = state.metrics.solRaised.toFixed(2);
    refs.statVerified.textContent = state.metrics.verified.toString();
    refs.statAdmins.textContent = state.metrics.admins.toString();
}

function buildActivityFeed() {
    const activities = [];
    state.contributions.slice(0, 5).forEach((entry) => {
        activities.push({
            type: 'contribution',
            title: `${formatWallet(entry.wallet_address)} contributed ${Number(entry.sol_amount || 0).toFixed(2)} SOL`,
            time: entry.created_at
        });
    });
    state.waitlist.slice(0, 5).forEach((entry) => {
        activities.push({
            type: 'waiting',
            title: `${entry.email || 'Unknown'} joined waiting list`,
            time: entry.created_at
        });
    });
    state.verifiedUsers.slice(0, 5).forEach((entry) => {
        activities.push({
            type: entry.verification_status === 'verified' ? 'verified' : 'pending',
            title: `${formatWallet(entry.wallet_address)} status: ${(entry.verification_status || 'pending').toUpperCase()}`,
            time: entry.updated_at || entry.created_at
        });
    });
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));
    refs.activityFeed.innerHTML = activities.slice(0, 8).map((activity) => {
        const badge = renderActivityBadge(activity.type);
        return `<li>
            <span>${activity.title}</span>
            <span class="activity-meta">${badge} ${formatDate(activity.time)}</span>
        </li>`;
    }).join('') || '<li class="activity-meta">No recent activity.</li>';
}

function renderActivityBadge(type) {
    switch (type) {
        case 'contribution':
            return '<span class="badge badge-success">Contribution</span>';
        case 'waiting':
            return '<span class="badge badge-neutral">Signup</span>';
        case 'verified':
            return '<span class="badge badge-success">Verified</span>';
        default:
            return '<span class="badge badge-warn">Pending</span>';
    }
}

async function refreshSystemStatus() {
    try {
        refs.statusApi.textContent = '…';
        refs.statusDb.textContent = '…';
        const apiOk = await pingFunctions();
        refs.statusApi.textContent = apiOk ? 'Online' : 'Issue';
        refs.statusApiMeta.textContent = apiOk ? 'Edge function reachable' : 'No response';
        const dbOk = state.waitlist.length >= 0 && state.contributions.length >= 0;
        refs.statusDb.textContent = dbOk ? 'Online' : 'Issue';
        refs.statusDbMeta.textContent = dbOk ? 'Queries succeeding' : 'Query errors';
        const latestBackup = state.backups[0];
        refs.statusBackup.textContent = latestBackup ? `${formatDate(latestBackup.timestamp)} · ${latestBackup.notes || 'No notes'}` : 'Not recorded yet';
        state.lastSystemCheck = new Date();
    } catch (error) {
        console.error('Status check failed', error);
        refs.statusApi.textContent = 'Issue';
        refs.statusApiMeta.textContent = 'Error pinging API';
    }
}

async function pingFunctions() {
    try {
        const response = await fetch(`${SUPABASE_FUN_URL}/get-status`, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
            }
        });
        return response.ok;
    } catch (error) {
        return false;
    }
}

function exportWaitlist(rows, lite = false) {
    if (!rows.length) {
        toast('No waiting list data to export', 'info');
        return;
    }
    const dataset = rows.map((row) => lite ? {
        email: row.email,
        wallet: row.wallet_address,
        telegram: row.telegram_handle,
        interest: row.interest_level,
        notified: row.notified,
        created_at: row.created_at
    } : row);
    downloadCSV('waiting_list.csv', dataset);
    toast('Waiting list exported', 'success');
}

function exportContributions(rows, lite = false) {
    if (!rows.length) {
        toast('No contributions to export', 'info');
        return;
    }
    const dataset = rows.map((row) => lite ? {
        wallet: row.wallet_address,
        tier: row.tier_name || row.tier_id,
        sol_amount: row.sol_amount,
        token_amount: row.token_amount,
        created_at: row.created_at
    } : row);
    downloadCSV('presale_contributions.csv', dataset);
    toast('Contributions exported', 'success');
}

function exportUsers(rows) {
    if (!rows.length) {
        toast('No verified users to export', 'info');
        return;
    }
    const dataset = rows.map((row) => ({
        wallet: row.wallet_address,
        twitter: row.twitter_handle,
        telegram: row.telegram_handle,
        status: row.verification_status,
        created_at: row.created_at
    }));
    downloadCSV('verified_users.csv', dataset);
    toast('User list exported', 'success');
}

function downloadCSV(filename, rows) {
    const headers = Object.keys(rows[0] || {});
    const csv = [headers.join(',')].concat(rows.map((row) => headers.map((header) => formatCSVValue(row[header])).join(','))).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

function formatCSVValue(value) {
    if (value === null || value === undefined) return '""';
    const str = value.toString().replace(/"/g, '""');
    return `"${str}"`;
}

function updateContributionFilters() {
    const select = document.getElementById('filter-tier');
    if (!select) return;
    const tiers = Array.from(new Set(state.contributions.map((row) => row.tier_name || (row.tier_id ? `Tier ${row.tier_id}` : 'Unspecified'))));
    select.innerHTML = '<option value="all">All tiers</option>' + tiers.map((tier) => `<option value="${tier}">${tier}</option>`).join('');
}

function hydrateLocalBackups() {
    try {
        const raw = localStorage.getItem('opclw_admin_backups');
        state.backups = raw ? JSON.parse(raw) : [];
        state.backups.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        if (state.backups[0]) {
            refs.statusBackup.textContent = `${formatDate(state.backups[0].timestamp)} · ${state.backups[0].notes || 'No notes'}`;
        }
    } catch (error) {
        state.backups = [];
    }
}

function saveBackupEntry() {
    const dateInput = document.getElementById('backup-input');
    const notesInput = document.getElementById('backup-notes');
    const timestamp = dateInput.value || new Date().toISOString();
    const notes = notesInput.value.trim();
    state.backups.unshift({ timestamp, notes });
    localStorage.setItem('opclw_admin_backups', JSON.stringify(state.backups));
    refs.statusBackup.textContent = `${formatDate(timestamp)} · ${notes || 'No notes'}`;
    dateInput.value = '';
    notesInput.value = '';
    toast('Backup entry saved locally.', 'success');
}

function setTableLoading(tbody, columns) {
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="${columns}" style="padding:18px;color:var(--muted);text-align:center;">Loading…</td></tr>`;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
}

function formatWallet(value) {
    if (!value) return '—';
    return value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

function formatNumber(value) {
    if (!value && value !== 0) return '0';
    if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + 'M';
    if (value >= 1_000) return (value / 1_000).toFixed(1) + 'K';
    return value.toLocaleString();
}

function toast(message, type = 'info') {
    if (!refs.toastBox) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    refs.toastBox.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }, 3200);
}

function debounce(fn, wait = 200) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
}

async function handleLogout() {
    try {
        await state.supabase.auth.signOut();
    } catch (error) {
        console.error('Logout failed', error);
    } finally {
        localStorage.removeItem('admin_session');
        window.location.href = '../index.html';
    }
}
