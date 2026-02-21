/*
 * Agent Dashboard Controller
 * - Connects Phantom/Solflare wallets using @solana/web3.js
 * - Reads SOL + OPCLW token balances from devnet
 * - Interacts with Agent Registry, Task Marketplace, and Knowledge Vault programs
 * - All transactions are built client-side and signed inside the user's wallet (never storing private keys)
 */

const { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, clusterApiUrl, Keypair } = window.solanaWeb3 || {};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LAMPORTS_PER_SOL = 1_000_000_000;
const OPCLW_DECIMALS = 1_000_000_000; // 9 decimals

const PROGRAM_IDS = (function () {
    try {
        const P = (window.solanaWeb3 || {}).PublicKey;
        if (!P) return {};
        return {
            agentRegistry: new P('BJguwXHSe67eoqHQjATboCPK6u7zaLhPrTSj65RTJGSg'),
            taskMarketplace: new P('3aiES4fjQwPAyKxUEkR9sYDpXuGtpkd5B368prXyHhXJ'),
            knowledgeVault: new P('8G59DbwXcjdcrwKnDJnynokXPh2MtR6VHHxWbFvNzgGG'),
            opclwMint: new P('Duo62HVJ2nu2ViEqoJrUHubzvBdDDNdvU4gDpfHo1q7o')
        };
    } catch (e) { return {}; }
})();

const INSTRUCTION_DISCRIMINATORS = {
    createTask: Uint8Array.from([194, 80, 6, 180, 232, 127, 48, 171]),
    acceptTask: Uint8Array.from([222, 196, 79, 165, 120, 30, 38, 120]),
    completeTask: Uint8Array.from([109, 167, 192, 41, 129, 108, 220, 196]),
    publishLesson: Uint8Array.from([166, 244, 160, 23, 160, 37, 13, 54])
};

const TASK_STATUS = ['Open', 'In Progress', 'Completed', 'Cancelled'];

const state = {
    provider: null,
    wallet: null,
    agentPda: null,
    connection: null,
    tasks: [],
    lessons: [],
    vaultState: null,
    profile: null,
    profileStats: { tasksCompleted: 0, earnings: 0 }
};

const MOBILE_WALLET_REGEX = /iPhone|iPad|iPod|Android/i;
const PHANTOM_DEEPLINK_BASE = 'https://phantom.app/ul/browse/';

function isMobileBrowser() {
    if (typeof navigator === 'undefined') return false;
    return MOBILE_WALLET_REGEX.test(navigator.userAgent || '');
}

function updateConnectButtonUi(button = $('#connect-wallet')) {
    if (!button) return;
    const mobile = isMobileBrowser();
    const label = mobile ? 'Open in Phantom App' : 'Connect Phantom Wallet';
    button.textContent = label;
    button.setAttribute('aria-label', label);

    let hint = document.getElementById('mobile-wallet-hint');
    if (mobile) {
        if (!hint) {
            hint = document.createElement('small');
            hint.id = 'mobile-wallet-hint';
            hint.style.display = 'block';
            hint.style.marginTop = '6px';
            hint.style.fontSize = '.78rem';
            hint.style.color = 'var(--g300)';
            hint.style.flexBasis = '100%';
            hint.style.marginLeft = '0';
            button.parentElement?.appendChild(hint);
        }
        hint.textContent = 'Tap to launch Phantom mobile browser, then connect your wallet.';
    } else if (hint?.parentElement) {
        hint.parentElement.removeChild(hint);
    }
}

function $(id) {
    return document.getElementById(id);
}

function setProfileBadge(text, variant = 'pending') {
    var badge = $('#profile-status-badge');
    if (!badge) return;
    badge.className = 'status-badge ' + variant;
    badge.textContent = text;
}

function setProfileMetric(id, value) {
    var el = document.getElementById(id);
    if (el != null) {
        el.textContent = value;
    }
}

function formatOpclw(value) {
    var num = Number(value || 0);
    return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function setProfileSaveState(message, type) {
    var el = document.getElementById('profile-save-state');
    if (!el) return;
    el.textContent = message || '';
    if (!message) return;
    var colors = {
        ok: 'var(--green)',
        err: 'var(--red)',
        pending: 'var(--g300)'
    };
    el.style.color = colors[type] || 'var(--g300)';
}

function hydrateProfileForm(profile) {
    var form = document.getElementById('profile-form');
    if (!form) return;
    var mappings = [
        ['profile-name', profile?.display_name || ''],
        ['profile-bio', profile?.bio || ''],
        ['profile-contact', profile?.contact || ''],
        ['profile-timezone', profile?.timezone || '']
    ];
    mappings.forEach(function (item) {
        var el = document.getElementById(item[0]);
        if (el) el.value = item[1];
    });
}

function applyProfileData(profile) {
    if (state.wallet) {
        setProfileBadge('Wallet connected', 'ready');
        setProfileMetric('profile-wallet', shorten(state.wallet.toBase58()));
    } else {
        setProfileBadge('Connect wallet', 'pending');
        setProfileMetric('profile-wallet', '—');
    }
    var rep = profile && profile.reputation_score != null ? profile.reputation_score : 0;
    setProfileMetric('profile-reputation', rep);
    var tasksCompleted = profile && profile.tasks_completed != null ? profile.tasks_completed : state.profileStats.tasksCompleted || 0;
    setProfileMetric('profile-task-count', tasksCompleted);
    var earnings = profile && profile.lifetime_earnings != null ? Number(profile.lifetime_earnings) : (state.profileStats.earnings || 0);
    setProfileMetric('profile-earnings', formatOpclw(earnings));
}

async function loadAgentProfile() {
    if (!state.wallet || typeof window.getAgentProfile !== 'function') {
        state.profile = null;
        applyProfileData(null);
        return;
    }
    setProfileBadge('Loading profile…', 'pending');
    try {
        var result = await window.getAgentProfile(state.wallet.toBase58());
        if (result && result.error) throw result.error;
        state.profile = result ? result.data : null;
        hydrateProfileForm(state.profile || {});
        applyProfileData(state.profile);
        setProfileBadge('Profile synced', 'ready');
    } catch (err) {
        console.warn('Profile load failed', err);
        state.profile = null;
        applyProfileData(null);
        setProfileBadge('Profile unavailable', 'pending');
    }
}

async function handleProfileSave(event) {
    event.preventDefault();
    if (!ensureWallet()) {
        setProfileSaveState('Connect your wallet first.', 'err');
        return;
    }
    if (typeof window.upsertAgentProfile !== 'function') {
        setProfileSaveState('Supabase unavailable.', 'err');
        return;
    }
    var formData = new FormData(event.target);
    var payload = {
        wallet_address: state.wallet.toBase58(),
        display_name: (formData.get('display_name') || '').toString().trim() || null,
        bio: (formData.get('bio') || '').toString().trim() || null,
        contact: (formData.get('contact') || '').toString().trim() || null,
        timezone: (formData.get('timezone') || '').toString().trim() || null,
        reputation_score: state.profile && state.profile.reputation_score != null ? state.profile.reputation_score : 0,
        tasks_completed: state.profile && state.profile.tasks_completed != null ? state.profile.tasks_completed : state.profileStats.tasksCompleted || 0,
        lifetime_earnings: state.profile && state.profile.lifetime_earnings != null ? state.profile.lifetime_earnings : state.profileStats.earnings || 0
    };
    setProfileSaveState('Saving profile…', 'pending');
    try {
        var result = await window.upsertAgentProfile(payload);
        if (result && result.error) throw result.error;
        state.profile = result ? result.data : payload;
        hydrateProfileForm(state.profile || {});
        applyProfileData(state.profile);
        setProfileBadge('Profile synced', 'ready');
        setProfileSaveState('Profile updated.', 'ok');
    } catch (err) {
        console.error('Profile update failed', err);
        setProfileSaveState('Unable to save profile.', 'err');
    }
}

function updateProfileStatsFromTasks() {
    if (!state.wallet) return;
    var myWallet = state.wallet.toBase58();
    var completed = state.tasks.filter(function (task) {
        return task.status === 'Completed' && task.assignedAgent === myWallet;
    });
    var earnings = completed.reduce(function (sum, task) {
        return sum + (Number(task.reward) || 0) / OPCLW_DECIMALS;
    }, 0);
    state.profileStats.tasksCompleted = completed.length;
    state.profileStats.earnings = earnings;
    if (!state.profile || state.profile.tasks_completed == null) {
        setProfileMetric('profile-task-count', completed.length);
    }
    if (!state.profile || state.profile.lifetime_earnings == null) {
        setProfileMetric('profile-earnings', formatOpclw(earnings));
    }
}


async function init() {
function toastSafe(msg, type = 'info') {
    if (typeof window.toast === 'function') {
        window.toast(msg, type);
    } else {
        console.log(`[${type}]`, msg);
    }
}

async function init() {
    $('#create-task-btn')?.addEventListener('click', () => toggleModal('create-task-modal', true));
    $('#publish-lesson-btn')?.addEventListener('click', () => toggleModal('publish-lesson-modal', true));
    document.querySelectorAll('[data-close-modal]')
        .forEach((btn) => btn.addEventListener('click', () => {
            const modal = btn.closest('.modal-backdrop');
            if (modal) toggleModal(modal.id, false);
        }));
    $('#create-task-form')?.addEventListener('input', updateTaskPreview);
    $('#create-task-form')?.addEventListener('submit', handleCreateTask);
    $('#publish-lesson-form')?.addEventListener('input', updateLessonPreview);
    $('#publish-lesson-form')?.addEventListener('submit', handlePublishLesson);
    $('#profile-form')?.addEventListener('submit', handleProfileSave);

    const connectButton = $('#connect-wallet');
    if (connectButton) {
        updateConnectButtonUi(connectButton);
        connectButton.addEventListener('click', connectWallet);
    }

    if (!window.solanaWeb3) {
        console.warn('Solana web3.js not loaded yet.');
        return;
    }
    state.connection = new Connection(clusterApiUrl('devnet'), 'confirmed');
    $('#refresh-tasks')?.addEventListener('click', loadTasks);
    $('#refresh-lessons')?.addEventListener('click', loadLessons);
}

document.addEventListener('DOMContentLoaded', init);

function getProvider() {
    if ('solana' in window && window.solana?.isPhantom) {
        return window.solana;
    }
    toastSafe('Phantom wallet not detected. Install Phantom to continue.', 'err');
    return null;
}

async function connectWallet() {
    const mobile = isMobileBrowser();
    const hasInjectedProvider = typeof window !== 'undefined' && window.solana?.isPhantom;
    if (mobile && !hasInjectedProvider) {
        toastSafe('Opening Phantom mobile app…', 'info');
        const currentUrl = encodeURIComponent(window.location.href);
        const origin = typeof window !== 'undefined' ? encodeURIComponent(window.location.origin) : '';
        const deeplink = origin ? `${PHANTOM_DEEPLINK_BASE}${currentUrl}?ref=${origin}` : `${PHANTOM_DEEPLINK_BASE}${currentUrl}`;
        window.location.href = deeplink;
        return;
    }
    const provider = getProvider();
    if (!provider) return;
    try {
        const resp = await provider.connect();
        state.wallet = new PublicKey(resp.publicKey.toString());
        state.provider = provider;
        provider.on('accountChanged', handleAccountChange);
        updateWalletSection();
        await Promise.all([fetchBalances(), deriveAgentPda(), loadTasks(), loadLessons(), loadAgentProfile()]);
        toastSafe('Wallet connected');
    } catch (err) {
        toastSafe(err.message || 'Wallet connection rejected', 'err');
    }
}

function handleAccountChange(newPubkey) {
    if (!newPubkey) {
        state.wallet = null;
        state.agentPda = null;
        updateWalletSection();
        return;
    }
    state.wallet = new PublicKey(newPubkey.toString());
    deriveAgentPda().then(() => {
        fetchBalances();
        loadTasks();
        loadLessons();
        loadAgentProfile();
    });
}

async function deriveAgentPda() {
    if (!state.wallet) return;
    const [agentPda] = await PublicKey.findProgramAddress(
        [encoder.encode('agent'), state.wallet.toBuffer()],
        PROGRAM_IDS.agentRegistry
    );
    state.agentPda = agentPda;
    const accountInfo = await state.connection.getAccountInfo(agentPda);
    const statusEl = $('#registry-status');
    if (statusEl) {
        statusEl.textContent = accountInfo ? 'Registered' : 'Not registered';
    }
}

async function fetchBalances() {
    if (!state.wallet) return;
    try {
        const solLamports = await state.connection.getBalance(state.wallet);
        $('#sol-balance').textContent = (solLamports / LAMPORTS_PER_SOL).toFixed(4);
    } catch (err) {
        console.error(err);
    }

    try {
        const tokens = await state.connection.getParsedTokenAccountsByOwner(state.wallet, { mint: PROGRAM_IDS.opclwMint });
        const amount = tokens.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
        const balance = amount ? Number(amount.uiAmountString || amount.uiAmount || 0) : 0;
        const formatted = balance.toLocaleString();
        $('#opclw-balance').textContent = formatted;
        setProfileMetric('profile-balance', formatted);
    } catch (err) {
        console.error(err);
    }
}

function updateWalletSection() {
    const info = $('#wallet-info');
    const addressEl = $('#wallet-address');
    if (!info || !addressEl) return;
    if (state.wallet) {
        const full = state.wallet.toBase58();
        addressEl.textContent = shorten(full);
        addressEl.dataset.full = full;
        addressEl.title = full;
        info.classList.add('visible');
        setProfileBadge('Wallet connected', 'ready');
    } else {
        info.classList.remove('visible');
        addressEl.textContent = '';
        addressEl.dataset.full = '';
        addressEl.removeAttribute('title');
        $('#sol-balance').textContent = '0.0000';
        $('#opclw-balance').textContent = '0';
        $('#registry-status').textContent = 'Not registered';
        setProfileMetric('profile-balance', '0');
        state.profile = null;
        state.profileStats = { tasksCompleted: 0, earnings: 0 };
        hydrateProfileForm({});
    }
    applyProfileData(state.profile);
    if (typeof window.setConnectedWallet === 'function') {
        window.setConnectedWallet(state.wallet ? state.wallet.toBase58() : null);
    }
}

async function loadTasks() {
    // Try Supabase first, then fallback to on-chain
    if (typeof window.loadTasksFromSupabase === 'function') {
        const result = await window.loadTasksFromSupabase();
        if (result.data && result.data.length > 0) {
            state.tasks = result.data.map(t => ({
                pubkey: t.on_chain_pubkey || t.id,
                title: t.title,
                description: t.description,
                reward: t.reward_amount,
                creator: t.creator_wallet,
                assignedAgent: t.assignee_wallet,
                status: t.status,
                skills: t.skills,
                createdAt: new Date(t.created_at).getTime()
            }));
            renderTasks();
            return;
        }
    }
    
    // Fallback to on-chain loading
    if (!state.connection) return;
    try {
        const accounts = await state.connection.getProgramAccounts(PROGRAM_IDS.taskMarketplace, {
            commitment: 'confirmed'
        });
        state.tasks = accounts
            .map(({ pubkey, account }) => {
                const data = accountDataToBytes(account.data);
                return deserializeTaskAccount(pubkey, data);
            })
            .filter(Boolean)
            .sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
        console.error('Task fetch error', err);
        toastSafe('Failed to load tasks from devnet', 'err');
        if (!state.tasks.length) {
            state.tasks = []; // fallback
        }
    }
    renderTasks();
}

function renderTasks() {
    const list = $('#task-list');
    const createdWrap = $('#created-tasks');
    const acceptedWrap = $('#accepted-tasks');
    if (!list) return;
    if (!state.tasks.length) {
        list.innerHTML = '<div class="empty-state">No tasks on-chain yet.</div>';
        createdWrap.innerHTML = '<div class="empty-state">No tasks created yet.</div>';
        acceptedWrap.innerHTML = '<div class="empty-state">No accepted tasks yet.</div>';
        if (state.wallet) {
            state.profileStats.tasksCompleted = 0;
            state.profileStats.earnings = 0;
            applyProfileData(state.profile);
        }
        return;
    }
    list.innerHTML = state.tasks.map(renderTaskCard).join('');
    const myPub = state.wallet?.toBase58();
    const created = state.tasks.filter((t) => t.creator === myPub);
    const accepted = state.tasks.filter((t) => t.assignedAgent === myPub);
    createdWrap.innerHTML = created.length ? created.map((t) => renderTaskCard(t, true)).join('') : '<div class="empty-state">No tasks created yet.</div>';
    acceptedWrap.innerHTML = accepted.length ? accepted.map((t) => renderTaskCard(t, true)).join('') : '<div class="empty-state">No accepted tasks yet.</div>';
    attachTaskActions();
    updateProfileStatsFromTasks();
    applyProfileData(state.profile);
}

function renderTaskCard(task, compact = false) {
    const statusClass = {
        Open: 'status-open',
        'In Progress': 'status-progress',
        Completed: 'status-completed',
        Cancelled: 'status-cancelled'
    }[task.status] || 'status-open';
    const reward = (task.reward / OPCLW_DECIMALS).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const showAccept = task.status === 'Open' && state.wallet && task.creator !== state.wallet.toBase58();
    const showComplete = task.status === 'In Progress' && state.wallet && task.creator === state.wallet.toBase58();
    const showProofForm = compact && task.status === 'In Progress' && state.wallet && task.assignedAgent === state.wallet.toBase58();
    return `
        <div class="task-card" data-task="${task.pubkey}">
            <span class="task-status ${statusClass}">${task.status}</span>
            <h3>${escapeHtml(task.title)}</h3>
            <p style="color:var(--g300); font-size:.9rem;">${escapeHtml(task.description)}</p>
            <div class="task-meta">
                <span>Reward: <strong>${reward} OPCLW</strong></span>
                <span>Creator: ${shorten(task.creator)}</span>
                ${task.assignedAgent ? `<span>Assignee: ${shorten(task.assignedAgent)}</span>` : ''}
            </div>
            ${task.skills?.length ? `<div class="lesson-tags">${task.skills.map((s) => `<span class="lesson-tag">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
            ${showAccept ? `<button class="btn btn-green btn-sm" data-accept="${task.pubkey}">Accept Task</button>` : ''}
            ${showComplete ? `<button class="btn btn-purple btn-sm" data-complete="${task.pubkey}">Mark Complete</button>` : ''}
            ${showProofForm ? `
                <div class="inline-form">
                    <textarea placeholder="Proof link or notes" data-proof-text="${task.pubkey}"></textarea>
                    <button class="btn btn-purple btn-sm" data-submit-proof="${task.pubkey}">Submit Completion</button>
                </div>` : ''}
        </div>
    `;
}

function attachTaskActions() {
    document.querySelectorAll('[data-accept]').forEach((btn) => {
        btn.onclick = () => handleAcceptTask(btn.dataset.accept);
    });
    document.querySelectorAll('[data-complete]').forEach((btn) => {
        btn.onclick = () => handleCompleteTask(btn.dataset.complete);
    });
    document.querySelectorAll('[data-submit-proof]').forEach((btn) => {
        btn.onclick = () => {
            const textarea = document.querySelector(`[data-proof-text="${btn.dataset.submitProof}"]`);
            submitCompletionProof(btn.dataset.submitProof, textarea?.value || '');
        };
    });
}

async function handleCreateTask(event) {
    event.preventDefault();
    if (!ensureWallet()) return;
    const form = event.target;
    const formData = new FormData(form);
    const payload = buildTaskPayload(formData);
    const taskAccount = Keypair.generate();
    try {
        const ix = new TransactionInstruction({
            programId: PROGRAM_IDS.taskMarketplace,
            keys: [
                { pubkey: taskAccount.publicKey, isSigner: true, isWritable: true },
                { pubkey: state.wallet, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
            ],
            data: payload
        });
        const tx = await buildTransaction([ix], [taskAccount]);
        const sig = await sendTransaction(tx);
        toastSafe(`Task created. Signature: ${sig.slice(0, 12)}…`, 'ok');
        toggleModal('create-task-modal', false);
        form.reset();
        updateTaskPreview();
        await loadTasks();
    } catch (err) {
        console.error(err);
        toastSafe(err.message || 'Task creation failed', 'err');
    }
}

async function handleAcceptTask(taskPubkey) {
    if (!ensureWallet()) return;
    if (!state.agentPda) {
        await deriveAgentPda();
        if (!state.agentPda) {
            toastSafe('Register your agent before accepting tasks.', 'warn');
            return;
        }
    }
    try {
        const ix = new TransactionInstruction({
            programId: PROGRAM_IDS.taskMarketplace,
            keys: [
                { pubkey: new PublicKey(taskPubkey), isSigner: false, isWritable: true },
                { pubkey: state.agentPda, isSigner: false, isWritable: false },
                { pubkey: state.wallet, isSigner: true, isWritable: false }
            ],
            data: INSTRUCTION_DISCRIMINATORS.acceptTask
        });
        const tx = await buildTransaction([ix]);
        const sig = await sendTransaction(tx);
        toastSafe(`Task accepted. Signature: ${sig.slice(0, 12)}…`, 'ok');
        await loadTasks();
    } catch (err) {
        console.error(err);
        toastSafe(err.message || 'Accept task failed', 'err');
    }
}

async function handleCompleteTask(taskPubkey) {
    if (!ensureWallet()) return;
    try {
        const ix = new TransactionInstruction({
            programId: PROGRAM_IDS.taskMarketplace,
            keys: [
                { pubkey: new PublicKey(taskPubkey), isSigner: false, isWritable: true },
                { pubkey: state.wallet, isSigner: true, isWritable: false }
            ],
            data: INSTRUCTION_DISCRIMINATORS.completeTask
        });
        const tx = await buildTransaction([ix]);
        const sig = await sendTransaction(tx);
        toastSafe(`Task marked complete. Signature: ${sig.slice(0, 12)}…`, 'ok');
        await Promise.all([loadTasks(), fetchBalances()]);
    } catch (err) {
        console.error(err);
        toastSafe(err.message || 'Complete task failed', 'err');
    }
}

async function submitCompletionProof(taskPubkey, proofText) {
    // Placeholder for submit_completion instruction when exposed.
    toastSafe('Submit completion not yet on-chain. Share proof with creator manually.', 'warn');
}

function buildTaskPayload(formData) {
    const title = (formData.get('title') || '').trim();
    const description = (formData.get('description') || '').trim();
    const reward = Number(formData.get('reward') || 0);
    const deadlineValue = formData.get('deadline');
    const deadline = deadlineValue ? Math.floor(new Date(deadlineValue).getTime() / 1000) : 0;
    const skills = (formData.get('skills') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const minRep = Math.max(0, Math.min(100, Number(formData.get('minReputation') || 0)));

    const rewardLamports = BigInt(Math.round(reward * OPCLW_DECIMALS));
    const deadlineBig = BigInt(deadline);

    const parts = [
        INSTRUCTION_DISCRIMINATORS.createTask,
        encodeString(title),
        encodeString(description),
        encodeU64(rewardLamports),
        encodeI64(deadlineBig),
        encodeStringVec(skills),
        encodeU8(minRep)
    ];
    return concatBytes(...parts);
}

function updateTaskPreview() {
    const form = $('#create-task-form');
    if (!form) return;
    const formData = new FormData(form);
    const title = formData.get('title')?.toString() || 'Untitled';
    const reward = formData.get('reward') || '0';
    const skills = (formData.get('skills') || '').toString();
    $('#task-preview').textContent = `Program: ${PROGRAM_IDS.taskMarketplace.toBase58()}\nTitle: ${title}\nReward: ${reward} OPCLW\nSkills: ${skills || '—'}`;
}

async function loadLessons() {
    if (typeof window.loadLessonsFromSupabase === 'function') {
        try {
            const result = await window.loadLessonsFromSupabase();
            if (!result.error && result.data && result.data.length) {
                state.lessons = result.data.map(mapSupabaseLesson).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
                renderLessons();
                return;
            }
            if (result.error) {
                console.warn('Supabase lessons error', result.error);
            }
        } catch (supabaseErr) {
            console.warn('Supabase lessons exception', supabaseErr);
        }
    }

    if (!state.connection) return;
    try {
        const accounts = await state.connection.getProgramAccounts(PROGRAM_IDS.knowledgeVault, {
            commitment: 'confirmed'
        });
        const lessons = [];
        for (const { pubkey, account } of accounts) {
            const data = accountDataToBytes(account.data);
            const decoded = deserializeLessonAccount(pubkey, data);
            if (decoded) lessons.push(decoded);
        }
        state.lessons = lessons.sort((a, b) => b.createdAt - a.createdAt);
    } catch (err) {
        console.error('Lesson fetch error', err);
        toastSafe('Unable to load Knowledge Vault entries', 'err');
    }
    renderLessons();
}

function renderLessons() {
    const list = $('#lesson-list');
    if (!list) return;
    if (!state.lessons.length) {
        list.innerHTML = '<div class="empty-state">No lessons published yet.</div>';
        return;
    }
    list.innerHTML = state.lessons
        .map((lesson) => `
            <div class="lesson-card">
                <h3>${escapeHtml(lesson.title)}</h3>
                <p style="color:var(--g300); font-size:.9rem;">${escapeHtml(lesson.summary)}</p>
                <div class="lesson-meta">
                    <span>Author: ${shorten(lesson.author)}</span>
                    <span>Upvotes: ${lesson.upvotes}</span>
                </div>
                ${lesson.tags?.length ? `<div class="lesson-tags">${lesson.tags.map((t) => `<span class="lesson-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                <small style="color:var(--g400);">Published ${new Date(lesson.createdAt * 1000).toLocaleString()}</small>
            </div>
        `)
        .join('');
}

async function ensureVaultState() {
    if (!state.connection) return null;
    const [vaultPda] = await PublicKey.findProgramAddress([encoder.encode('vault')], PROGRAM_IDS.knowledgeVault);
    state.vaultPda = vaultPda;
    const accountInfo = await state.connection.getAccountInfo(vaultPda);
    if (!accountInfo) {
        throw new Error('Knowledge Vault not initialized yet. Run initialize_vault via CLI.');
    }
    const data = accountDataToBytes(accountInfo.data);
    let offset = 8;
    const authority = new PublicKey(data.slice(offset, offset + 32));
    offset += 32;
    const bump = data[offset];
    offset += 1;
    const totalLessons = Number(readU64(data, offset));
    offset += 8;
    state.vaultState = { totalLessons, authority: authority.toBase58(), bump };
    return state.vaultState;
}

async function handlePublishLesson(event) {
    event.preventDefault();
    if (!ensureWallet()) return;
    const form = event.target;
    const formData = new FormData(form);
    const title = (formData.get('title') || '').trim();
    const summary = (formData.get('summary') || '').trim();
    const content = (formData.get('content') || '').trim();
    const tags = (formData.get('tags') || '').split(',').map((t) => t.trim()).filter(Boolean).join(',');
    try {
        const vaultState = await ensureVaultState();
        const lessonId = BigInt((vaultState?.totalLessons || 0) + 1);
        const lessonSeeds = [encoder.encode('lesson'), state.vaultPda.toBuffer(), encodeU64(lessonId)];
        const [lessonPda] = await PublicKey.findProgramAddress(lessonSeeds, PROGRAM_IDS.knowledgeVault);
        const data = concatBytes(
            INSTRUCTION_DISCRIMINATORS.publishLesson,
            encodeU64(lessonId),
            encodeString(title),
            encodeString(summary),
            encodeString(content),
            encodeString(tags)
        );
        const ix = new TransactionInstruction({
            programId: PROGRAM_IDS.knowledgeVault,
            keys: [
                { pubkey: state.vaultPda, isSigner: false, isWritable: true },
                { pubkey: state.wallet, isSigner: true, isWritable: true },
                { pubkey: lessonPda, isSigner: false, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
            ],
            data
        });
        const tx = await buildTransaction([ix]);
        const sig = await sendTransaction(tx);
        toastSafe(`Lesson published. Signature: ${sig.slice(0, 12)}…`, 'ok');
        toggleModal('publish-lesson-modal', false);
        form.reset();
        updateLessonPreview();
        await loadLessons();
    } catch (err) {
        console.error(err);
        toastSafe(err.message || 'Publish failed', 'err');
    }
}

function updateLessonPreview() {
    const form = $('#publish-lesson-form');
    if (!form) return;
    const formData = new FormData(form);
    const title = formData.get('title') || 'Untitled Lesson';
    const tags = formData.get('tags') || '—';
    $('#lesson-preview').textContent = `Program: ${PROGRAM_IDS.knowledgeVault.toBase58()}\nTitle: ${title}\nTags: ${tags}`;
}

function ensureWallet() {
    if (!state.wallet || !state.provider) {
        toastSafe('Connect your wallet first', 'warn');
        return false;
    }
    return true;
}

async function buildTransaction(instructions, extraSigners = []) {
    const tx = new Transaction();
    instructions.forEach((ix) => tx.add(ix));
    tx.feePayer = state.wallet;
    const { blockhash } = await state.connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    if (extraSigners.length) {
        tx.partialSign(...extraSigners);
    }
    return tx;
}

async function sendTransaction(transaction) {
    if (!state.provider) throw new Error('Wallet not connected');
    if (typeof state.provider.signAndSendTransaction === 'function') {
        const result = await state.provider.signAndSendTransaction(transaction);
        return result.signature || result;
    }
    const signedTx = await state.provider.signTransaction(transaction);
    const signature = await state.connection.sendRawTransaction(signedTx.serialize());
    await state.connection.confirmTransaction(signature, 'confirmed');
    return signature;
}

function toggleModal(id, open) {
    const modal = $(id);
    if (!modal) return;
    modal.classList.toggle('open', open);
}

function shorten(addr) {
    if (!addr) return '';
    return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

function accountDataToBytes(data) {
    if (!data) return new Uint8Array();
    if (data instanceof Uint8Array) return data;
    if (Array.isArray(data)) return new Uint8Array(data);
    if (typeof data === 'object' && Array.isArray(data.data)) {
        const [b64] = data.data;
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    }
    if (typeof data === 'string') {
        return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    }
    return new Uint8Array();
}

function deserializeTaskAccount(pubkey, data) {
    try {
        let offset = 8; // discriminator
        const creator = new PublicKey(data.slice(offset, offset + 32));
        offset += 32;
        const titleRes = readString(data, offset);
        offset = titleRes.offset;
        const descRes = readString(data, offset);
        offset = descRes.offset;
        const reward = Number(readU64(data, offset));
        offset += 8;
        const deadline = Number(readI64(data, offset));
        offset += 8;
        const skillsRes = readStringVec(data, offset);
        offset = skillsRes.offset;
        const minRep = data[offset];
        offset += 1;
        const statusIdx = data[offset];
        offset += 1;
        const assignedFlag = data[offset];
        offset += 1;
        let assignedAgent = null;
        if (assignedFlag === 1) {
            assignedAgent = new PublicKey(data.slice(offset, offset + 32)).toBase58();
            offset += 32;
        }
        const createdAt = Number(readI64(data, offset));
        offset += 8;
        let completedAt = null;
        const completedFlag = data[offset];
        offset += 1;
        if (completedFlag === 1) {
            completedAt = Number(readI64(data, offset));
            offset += 8;
        }
        return {
            pubkey: pubkey.toBase58(),
            creator: creator.toBase58(),
            title: titleRes.value,
            description: descRes.value,
            reward,
            deadline,
            skills: skillsRes.value,
            minReputation: minRep,
            status: TASK_STATUS[statusIdx] || 'Open',
            assignedAgent,
            createdAt,
            completedAt
        };
    } catch (err) {
        console.warn('Failed to decode task', err);
        return null;
    }
}

function deserializeLessonAccount(pubkey, data) {
    try {
        let offset = 8;
        const vault = new PublicKey(data.slice(offset, offset + 32));
        offset += 32;
        const author = new PublicKey(data.slice(offset, offset + 32));
        offset += 32;
        offset += 1; // bump
        const lessonId = Number(readU64(data, offset));
        offset += 8;
        const upvotes = Number(readU64(data, offset));
        offset += 8;
        const createdAt = Number(readI64(data, offset));
        offset += 8;
        const updatedAt = Number(readI64(data, offset));
        offset += 8;
        const titleRes = readString(data, offset);
        offset = titleRes.offset;
        const summaryRes = readString(data, offset);
        offset = summaryRes.offset;
        const contentRes = readString(data, offset);
        offset = contentRes.offset;
        const tagsRes = readString(data, offset);
        offset = tagsRes.offset;
        return {
            pubkey: pubkey.toBase58(),
            vault: vault.toBase58(),
            author: author.toBase58(),
            lessonId,
            upvotes,
            createdAt,
            updatedAt,
            title: titleRes.value,
            summary: summaryRes.value,
            content: contentRes.value,
            tags: tagsRes.value ? tagsRes.value.split(',').map((t) => t.trim()).filter(Boolean) : []
        };
    } catch (err) {
        return null;
    }
}

function mapSupabaseLesson(row) {
    if (!row) return null;
    const created = row.created_at ? Math.floor(new Date(row.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const updated = row.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : created;
    const tagsArray = Array.isArray(row.tags)
        ? row.tags
        : typeof row.tags === 'string' && row.tags.length
            ? row.tags.split(',').map((t) => t.trim()).filter(Boolean)
            : [];
    return {
        pubkey: row.on_chain_pubkey || row.id || '',
        vault: row.vault || '',
        author: row.author_wallet || '',
        lessonId: row.id || row.on_chain_pubkey || '',
        upvotes: Number(row.upvotes) || 0,
        createdAt: created,
        updatedAt: updated,
        title: row.title || '',
        summary: row.summary || '',
        content: row.content || '',
        tags: tagsArray
    };
}

function readString(buffer, offset) {
    const len = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    const bytes = buffer.slice(offset, offset + len);
    offset += len;
    return { value: decoder.decode(bytes), offset };
}

function readStringVec(buffer, offset) {
    const len = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    const items = [];
    for (let i = 0; i < len; i++) {
        const res = readString(buffer, offset);
        offset = res.offset;
        items.push(res.value);
    }
    return { value: items, offset };
}

function readU64(buffer, offset) {
    return new DataView(buffer.buffer, buffer.byteOffset + offset, 8).getBigUint64(0, true);
}

function readI64(buffer, offset) {
    return new DataView(buffer.buffer, buffer.byteOffset + offset, 8).getBigInt64(0, true);
}

function encodeString(str) {
    const bytes = encoder.encode(str);
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, bytes.length, true);
    return concatBytes(new Uint8Array(lenBuf), bytes);
}

function encodeStringVec(arr) {
    const lenBuf = new ArrayBuffer(4);
    new DataView(lenBuf).setUint32(0, arr.length, true);
    const pieces = [new Uint8Array(lenBuf)];
    arr.forEach((item) => pieces.push(encodeString(item)));
    return concatBytes(...pieces);
}

function encodeU64(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(value), true);
    return new Uint8Array(buf);
}

function encodeI64(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigInt64(0, BigInt(value), true);
    return new Uint8Array(buf);
}

function encodeU8(value) {
    return Uint8Array.from([value & 0xff]);
}

function concatBytes(...arrays) {
    const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    arrays.forEach((arr) => {
        result.set(arr, offset);
        offset += arr.length;
    });
    return result;
}

// Expose toggleModal to global scope for inline onclick handlers
window.toggleModal = toggleModal;
