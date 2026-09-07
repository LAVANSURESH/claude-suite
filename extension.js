import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

/* -------------------------------------------------------------------- */
/* Shared helpers                                                        */
/* -------------------------------------------------------------------- */

function drawRoundedRect(cr, x, y, width, height, radius) {
    if (width <= 0 || height <= 0) return;
    if (width < 2 * radius) radius = width / 2;
    if (height < 2 * radius) radius = height / 2;
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, (3 * Math.PI) / 2);
    cr.closePath();
}

function expandPath(path) {
    if (!path)
        return GLib.get_home_dir();
    if (path === '~')
        return GLib.get_home_dir();
    if (path.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    return path;
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'scenario';
}

function timestamp() {
    return GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
}

function fmtCost(cost) {
    if (cost === null || cost === undefined) return 'n/a';
    return `$${cost.toFixed(2)}`;
}

function fmtDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function fmtTokens(tokens) {
    if (!tokens) return '0';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return `${tokens}`;
}

/* -------------------------------------------------------------------- */
/* Pipeline config                                                       */
/* -------------------------------------------------------------------- */

const CONFIG_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'claude-pipeline']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'scenarios.json']);

const DEFAULT_CONFIG = {
    terminal: 'gnome-terminal',
    claudeBin: 'claude',
    editor: 'xdg-open',
    outputDir: '~/claude-pipeline-reports',
    scenarios: [
        {
            name: 'Automation Report Analysis',
            mode: 'background',
            cwd: '~/Documents',
            prompt: 'Find the most recent automation/test run report in this directory (e.g. junit, playwright, cypress, or CI output). Summarize pass/fail counts, list the top failing scenarios with likely root cause, and flag any flaky-looking tests.',
            args: [],
            saveOutput: true,
        },
        {
            name: 'Daily Standup Digest',
            mode: 'background',
            cwd: '~/Documents/daily',
            prompt: 'Summarize my Jira tickets, GitHub PRs, and Confluence updates from the last working day into a short standup update (what I did, what I plan to do, blockers).',
            args: [],
            saveOutput: true,
        },
        {
            name: 'Interactive Session (this project)',
            mode: 'terminal',
            cwd: '~/Documents',
            prompt: '',
            args: [],
        },
    ],
};

/* -------------------------------------------------------------------- */
/* Widgets                                                                */
/* -------------------------------------------------------------------- */

const UsageProgressBarItem = GObject.registerClass(
class UsageProgressBarItem extends PopupMenu.PopupBaseMenuItem {
    _init(title, params = {}) {
        super._init({ reactive: false, ...params });

        this._pct = 0;

        const container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-suite-progress-section',
        });

        const headerBox = new St.BoxLayout({
            x_expand: true,
            style_class: 'claude-suite-progress-header',
        });

        this._titleLabel = new St.Label({
            text: title,
            style_class: 'claude-suite-progress-title',
        });
        headerBox.add_child(this._titleLabel);

        this._pctLabel = new St.Label({
            text: '0%',
            style_class: 'claude-suite-progress-pct',
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
        });
        headerBox.add_child(this._pctLabel);

        container.add_child(headerBox);

        this._drawingArea = new St.DrawingArea({
            style_class: 'claude-suite-progress-track',
            x_expand: true,
            height: 8,
        });

        this._drawingArea.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            if (w <= 0 || h <= 0) {
                cr.$dispose();
                return;
            }

            const radius = Math.min(h / 2, 4);

            cr.setSourceRGBA(1.0, 1.0, 1.0, 0.12);
            drawRoundedRect(cr, 0, 0, w, h, radius);
            cr.fill();

            if (this._pct > 0) {
                const safePct = Math.min(100, Math.max(0, this._pct));
                const fillWidth = Math.max(radius * 2, (w * safePct) / 100);

                if (safePct >= 90) cr.setSourceRGBA(0.88, 0.11, 0.14, 1.0);
                else if (safePct >= 70) cr.setSourceRGBA(0.90, 0.65, 0.04, 1.0);
                else cr.setSourceRGBA(0.21, 0.52, 0.89, 1.0);

                drawRoundedRect(cr, 0, 0, Math.min(w, fillWidth), h, radius);
                cr.fill();
            }

            cr.$dispose();
        });

        container.add_child(this._drawingArea);
        this.add_child(container);
    }

    setProgress(pct, resetText = '') {
        const safePct = Math.min(100, Math.max(0, Math.round(pct || 0)));
        let pctStr = `${safePct}%`;
        if (resetText)
            pctStr += ` (resets ${resetText})`;
        this._pctLabel.set_text(pctStr);
        this._pct = safePct;
        this._drawingArea.queue_repaint();
    }
});

const AccountListItem = GObject.registerClass(
class AccountListItem extends PopupMenu.PopupBaseMenuItem {
    _init(account, isCurrent, onSelect) {
        super._init({ reactive: true });

        const container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-suite-account-item-box',
        });

        const topRow = new St.BoxLayout({ x_expand: true });

        const prefix = isCurrent ? '● ' : '○ ';
        const identifier = account.alias ? `${account.alias} (${account.email})` : account.email;
        let extraInfo = '';
        if (account.disabled) extraInfo = ' [disabled]';
        else if (account.usage && account.usage.fiveHour) extraInfo = ` (${account.usage.fiveHour.pct}%)`;

        const label = new St.Label({
            text: `${prefix}#${account.number} ${identifier}${extraInfo}`,
            x_expand: true,
            style_class: isCurrent ? 'claude-suite-account-active' : '',
        });
        topRow.add_child(label);
        container.add_child(topRow);

        if (account.usage && account.usage.fiveHour && !account.disabled) {
            const pct = Math.min(100, Math.max(0, Math.round(account.usage.fiveHour.pct || 0)));
            const miniBar = new St.DrawingArea({
                style_class: 'claude-suite-mini-track',
                x_expand: true,
                height: 4,
            });
            miniBar.connect('repaint', area => {
                const cr = area.get_context();
                const [w, h] = area.get_surface_size();
                if (w <= 0 || h <= 0) {
                    cr.$dispose();
                    return;
                }
                const radius = 2;
                cr.setSourceRGBA(1.0, 1.0, 1.0, 0.10);
                drawRoundedRect(cr, 0, 0, w, h, radius);
                cr.fill();
                if (pct > 0) {
                    const fillWidth = Math.max(radius * 2, (w * pct) / 100);
                    if (pct >= 90) cr.setSourceRGBA(0.88, 0.11, 0.14, 1.0);
                    else if (pct >= 70) cr.setSourceRGBA(0.90, 0.65, 0.04, 1.0);
                    else cr.setSourceRGBA(0.21, 0.52, 0.89, 1.0);
                    drawRoundedRect(cr, 0, 0, Math.min(w, fillWidth), h, radius);
                    cr.fill();
                }
                cr.$dispose();
            });
            container.add_child(miniBar);
        }

        this.add_child(container);

        this.connect('activate', () => {
            if (onSelect) onSelect();
        });
    }
});

const TaskListItem = GObject.registerClass(
class TaskListItem extends PopupMenu.PopupBaseMenuItem {
    _init(task, onDelete) {
        super._init({ reactive: false });

        const container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-suite-task-box',
        });

        const topRow = new St.BoxLayout({ x_expand: true });
        const label = new St.Label({
            text: task.summary,
            x_expand: true,
            style_class: 'claude-suite-task-summary',
        });
        label.clutter_text.line_wrap = true;
        topRow.add_child(label);

        if (task.session_id && onDelete) {
            const icon = new St.Icon({
                icon_name: 'edit-delete-symbolic',
                style_class: 'claude-suite-task-delete-icon',
            });
            const deleteButton = new St.Button({
                style_class: 'claude-suite-task-delete',
                child: icon,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            const ARM_SECONDS = 4;
            let armed = false;
            let armTimeoutId = null;

            const disarm = () => {
                armed = false;
                if (armTimeoutId) {
                    GLib.Source.remove(armTimeoutId);
                    armTimeoutId = null;
                }
                deleteButton.remove_style_class_name('claude-suite-task-delete-armed');
            };

            deleteButton.connect('clicked', () => {
                if (!armed) {
                    armed = true;
                    deleteButton.add_style_class_name('claude-suite-task-delete-armed');
                    armTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ARM_SECONDS, () => {
                        armTimeoutId = null;
                        disarm();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                disarm();
                onDelete(task.session_id);
            });
            this.connect('destroy', disarm);

            topRow.add_child(deleteButton);
        }

        container.add_child(topRow);

        const metaRow = new St.BoxLayout({ x_expand: true });
        const repo = task.repository ? `${task.repository} · ` : '';
        const metaLabel = new St.Label({
            text: `${repo}${fmtTokens(task.tokens)} tok · ${fmtCost(task.cost_usd)}`,
            style_class: 'claude-suite-task-meta',
            x_expand: true,
        });
        metaRow.add_child(metaLabel);
        container.add_child(metaRow);

        this.add_child(container);
    }
});

const SessionListItem = GObject.registerClass(
class SessionListItem extends PopupMenu.PopupBaseMenuItem {
    _init(session, onResume) {
        super._init({ reactive: true });

        const container = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-suite-session-box',
        });

        const titleLabel = new St.Label({
            text: session.title,
            x_expand: true,
            style_class: 'claude-suite-session-title',
        });
        titleLabel.clutter_text.line_wrap = true;
        container.add_child(titleLabel);

        const projectName = session.cwd.split('/').filter(Boolean).pop() || session.cwd;
        const metaLabel = new St.Label({
            text: `${projectName} · ${session.mtime_str}`,
            style_class: 'claude-suite-session-meta',
        });
        container.add_child(metaLabel);

        this.add_child(container);

        this.connect('activate', () => onResume(session));
    }
});

const RunListItem = GObject.registerClass(
class RunListItem extends PopupMenu.PopupBaseMenuItem {
    _init(run, onOpen, onCancel) {
        super._init({ reactive: false });

        const box = new St.BoxLayout({ vertical: true, x_expand: true, style_class: 'claude-suite-run-box' });

        const topRow = new St.BoxLayout({ x_expand: true });
        const label = new St.Label({
            text: run.name,
            x_expand: true,
            style_class: 'claude-suite-run-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        topRow.add_child(label);

        if (run.status === 'running') {
            const cancelIcon = new St.Icon({ icon_name: 'process-stop-symbolic', icon_size: 16 });
            const cancelButton = new St.Button({
                style_class: 'claude-suite-run-action',
                child: cancelIcon,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            cancelButton.connect('clicked', () => onCancel(run));
            topRow.add_child(cancelButton);
        } else {
            const openIcon = new St.Icon({ icon_name: 'text-x-generic-symbolic', icon_size: 16 });
            const openButton = new St.Button({
                style_class: 'claude-suite-run-action',
                child: openIcon,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            openButton.connect('clicked', () => onOpen(run));
            topRow.add_child(openButton);
        }

        box.add_child(topRow);

        const statusWord = { running: 'Running…', done: 'Done', failed: 'Failed' }[run.status] ?? run.status;
        const metaLabel = new St.Label({ text: statusWord, style_class: 'claude-suite-run-meta' });
        box.add_child(metaLabel);

        this.add_child(box);

        if (run.status === 'running' && run.startTime) {
            const updateElapsed = () => {
                const elapsedMs = (GLib.get_monotonic_time() - run.startTime) / 1000;
                metaLabel.set_text(`${statusWord} ${fmtDuration(elapsedMs)}`);
            };
            updateElapsed();
            const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                updateElapsed();
                return GLib.SOURCE_CONTINUE;
            });
            this.connect('destroy', () => GLib.Source.remove(timeoutId));
        } else if (run.startTime && run.endTime) {
            const durationMs = (run.endTime - run.startTime) / 1000;
            metaLabel.set_text(`${statusWord} · ${fmtDuration(durationMs)}`);
        }
    }
});

const PipelineDashboard = GObject.registerClass(
class PipelineDashboard extends ModalDialog.ModalDialog {
    _init(ext) {
        super._init({ styleClass: 'claude-suite-dashboard' });
        this._ext = ext;

        const content = new St.BoxLayout({
            vertical: true,
            style_class: 'claude-suite-dashboard-content',
        });

        content.add_child(new St.Label({
            text: 'Pipeline Dashboard',
            style_class: 'claude-suite-dashboard-title',
        }));

        this._statsLabel = new St.Label({ style_class: 'claude-suite-dashboard-stats' });
        content.add_child(this._statsLabel);

        this._scroll = new St.ScrollView({
            style_class: 'claude-suite-dashboard-scroll',
            x_expand: true,
            y_expand: true,
        });
        this._runsBox = new St.BoxLayout({ vertical: true, x_expand: true });
        this._scroll.add_child(this._runsBox);
        content.add_child(this._scroll);

        this.contentLayout.add_child(content);

        this.setButtons([
            { label: 'Close', action: () => this.close(), key: Clutter.KEY_Escape },
        ]);

        this.refresh();
    }

    refresh() {
        const runs = this._ext._runs ?? [];
        const running = runs.filter(r => r.status === 'running').length;
        const done = runs.filter(r => r.status === 'done').length;
        const failed = runs.filter(r => r.status === 'failed').length;
        this._statsLabel.set_text(
            `Running: ${running}  ·  Done: ${done}  ·  Failed: ${failed}  ·  Total: ${runs.length}`
        );

        this._runsBox.destroy_all_children();
        if (runs.length === 0) {
            this._runsBox.add_child(new St.Label({
                text: 'No pipeline runs yet.',
                style_class: 'claude-suite-run-meta',
            }));
            return;
        }
        for (const run of runs) {
            this._runsBox.add_child(new RunListItem(
                run,
                r => this._ext._openRunOutput(r),
                r => this._ext._cancelRun(r)
            ));
        }
    }
});

/* -------------------------------------------------------------------- */
/* Extension                                                             */
/* -------------------------------------------------------------------- */

export default class ClaudeSuiteExtension extends Extension {
    enable() {
        this._enabled = true;
        this._config = DEFAULT_CONFIG;
        this._runs = [];
        this._runSeq = 0;

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const box = new St.BoxLayout({ style_class: 'panel-status-indicators-box claude-suite-panel-button' });
        this._icon = new St.Icon({ icon_name: 'system-users-symbolic', style_class: 'system-status-icon' });
        box.add_child(this._icon);
        this._label = new St.Label({ text: 'Claude: …', y_align: Clutter.ActorAlign.CENTER });
        box.add_child(this._label);
        this._runBadge = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-suite-run-badge',
        });
        this._runBadge.visible = false;
        box.add_child(this._runBadge);
        this._indicator.add_child(box);

        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._loadPipelineConfig();
        this._watchPipelineConfig();
        this._rebuildPipelineMenu();

        this._refreshSwap();
        this._swapTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._refreshSwap();
            return GLib.SOURCE_CONTINUE;
        });

        this._refreshUsage();
        this._usageTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this._refreshUsage();
            return GLib.SOURCE_CONTINUE;
        });

        this._refreshSessions();
    }

    disable() {
        this._enabled = false;
        if (this._swapTimeoutId) {
            GLib.Source.remove(this._swapTimeoutId);
            this._swapTimeoutId = null;
        }
        if (this._usageTimeoutId) {
            GLib.Source.remove(this._usageTimeoutId);
            this._usageTimeoutId = null;
        }
        this._fileMonitor?.cancel();
        this._fileMonitor = null;

        for (const run of this._runs) {
            if (run.status === 'running')
                run.cancellable?.cancel();
        }
        this._runs = [];

        this._dashboard?.close();
        this._dashboard?.destroy();
        this._dashboard = null;

        this._indicator?.destroy();
        this._indicator = null;
        this._config = null;
    }

    _notify(title, body, isError = false) {
        if (!this._enabled) return;
        const source = MessageTray.getSystemSource();
        const notification = new MessageTray.Notification({
            source, title, body,
            iconName: isError ? 'dialog-error-symbolic' : 'utilities-terminal-symbolic',
        });
        source.addNotification(notification);
    }

    _sessionEnviron() {
        if (this._cachedEnviron) return this._cachedEnviron;
        let envp = GLib.get_environ();
        try {
            const [ok, stdout] = GLib.spawn_command_line_sync('systemctl --user show-environment');
            if (ok) {
                const text = new TextDecoder('utf-8').decode(stdout);
                for (const line of text.split('\n')) {
                    const eq = line.indexOf('=');
                    if (eq <= 0) continue;
                    const key = line.slice(0, eq);
                    if (['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE'].includes(key))
                        envp = GLib.environ_setenv(envp, key, line.slice(eq + 1), true);
                }
            }
        } catch (e) {
            logError(e, 'Claude Suite: failed to read session environment');
        }
        this._cachedEnviron = envp;
        return envp;
    }

    _spawnDetached(argv, cwd = null) {
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.set_environ(this._sessionEnviron());
            if (cwd) launcher.set_cwd(cwd);
            const proc = launcher.spawnv(argv);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let stderr = '';
                try {
                    [, , stderr] = p.communicate_utf8_finish(res);
                } catch (_) {
                    return;
                }
                if (!p.get_successful() && stderr)
                    this._notify('Claude Suite', `"${argv.join(' ')}" exited with an error:\n${stderr}`, true);
            });
        } catch (e) {
            this._notify('Claude Suite', `Failed to launch: ${argv.join(' ')}\n${e.message}`, true);
        }
    }

    _updateTopBar() {
        if (!this._enabled) return;
        const runningCount = this._runs.filter(r => r.status === 'running').length;
        this._icon.icon_name = runningCount > 0 ? 'content-loading-symbolic' : 'system-users-symbolic';
        if (this._runBadge) {
            this._runBadge.visible = runningCount > 0;
            if (runningCount > 0) this._runBadge.set_text(`● ${runningCount}`);
        }
    }

    /* ---------------- Menu skeleton ---------------- */

    _buildMenu() {
        const menu = this._indicator.menu;
        menu.removeAll();

        // --- Account (claude-swap) ---
        this._accountSubMenu = new PopupMenu.PopupSubMenuMenuItem('Account: Loading…');
        menu.addMenuItem(this._accountSubMenu);

        this._activeHeader = new PopupMenu.PopupMenuItem('Active Account: Loading...', { reactive: false });
        this._accountSubMenu.menu.addMenuItem(this._activeHeader);

        this._installItem = new PopupMenu.PopupMenuItem('⬇️ Install cswap CLI...');
        this._installItem.visible = false;
        this._installItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://github.com/LAVANSURESH/claude-swap', null);
        });
        this._accountSubMenu.menu.addMenuItem(this._installItem);

        this._fiveHourProgress = new UsageProgressBarItem('5-Hour Quota');
        this._accountSubMenu.menu.addMenuItem(this._fiveHourProgress);

        this._sevenDayProgress = new UsageProgressBarItem('7-Day Quota');
        this._accountSubMenu.menu.addMenuItem(this._sevenDayProgress);

        this._accountSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Switch Account'));
        this._accountsSection = new PopupMenu.PopupMenuSection();
        this._accountSubMenu.menu.addMenuItem(this._accountsSection);

        this._accountSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshAccountItem = new PopupMenu.PopupMenuItem('🔄 Refresh Usage');
        refreshAccountItem.connect('activate', () => this._refreshSwap());
        this._accountSubMenu.menu.addMenuItem(refreshAccountItem);

        const tuiItem = new PopupMenu.PopupMenuItem('🖥️ Open Dashboard (TUI)');
        tuiItem.connect('activate', () => this._openTui());
        this._accountSubMenu.menu.addMenuItem(tuiItem);

        // --- Usage (claude-usage) ---
        this._usageSubMenu = new PopupMenu.PopupSubMenuMenuItem('Usage: Loading…');
        menu.addMenuItem(this._usageSubMenu);

        this._todayHeader = new PopupMenu.PopupMenuItem('Today: Loading...', { reactive: false });
        this._usageSubMenu.menu.addMenuItem(this._todayHeader);

        this._tasksSection = new PopupMenu.PopupMenuSection();
        this._usageSubMenu.menu.addMenuItem(this._tasksSection);

        this._usageSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._weekHeader = new PopupMenu.PopupMenuItem('Last 7 days: Loading...', { reactive: false });
        this._usageSubMenu.menu.addMenuItem(this._weekHeader);

        this._usageSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshUsageItem = new PopupMenu.PopupMenuItem('🔄 Refresh');
        refreshUsageItem.connect('activate', () => this._refreshUsage());
        this._usageSubMenu.menu.addMenuItem(refreshUsageItem);

        // --- Recent Sessions ---
        this._sessionsSubMenu = new PopupMenu.PopupSubMenuMenuItem('Recent Sessions');
        menu.addMenuItem(this._sessionsSubMenu);

        this._sessionsListSection = new PopupMenu.PopupMenuSection();
        this._sessionsSubMenu.menu.addMenuItem(this._sessionsListSection);

        this._sessionsSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshSessionsItem = new PopupMenu.PopupMenuItem('🔄 Refresh');
        refreshSessionsItem.connect('activate', () => this._refreshSessions());
        this._sessionsSubMenu.menu.addMenuItem(refreshSessionsItem);

        this._sessionsSubMenu.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._refreshSessions();
        });

        // --- Pipeline (claude-pipeline) ---
        this._pipelineSubMenu = new PopupMenu.PopupSubMenuMenuItem('Pipeline');
        menu.addMenuItem(this._pipelineSubMenu);

        this._scenariosSection = new PopupMenu.PopupMenuSection();
        this._pipelineSubMenu.menu.addMenuItem(this._scenariosSection);

        this._pipelineSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Running'));
        this._runningSection = new PopupMenu.PopupMenuSection();
        this._pipelineSubMenu.menu.addMenuItem(this._runningSection);

        this._pipelineSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('History'));
        this._runsSection = new PopupMenu.PopupMenuSection();
        this._pipelineSubMenu.menu.addMenuItem(this._runsSection);

        this._pipelineSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const dashboardItem = new PopupMenu.PopupMenuItem('Open Dashboard…');
        dashboardItem.connect('activate', () => this._openDashboard());
        this._pipelineSubMenu.menu.addMenuItem(dashboardItem);

        const editItem = new PopupMenu.PopupMenuItem('Edit Scenarios…');
        editItem.connect('activate', () => this._openPipelineConfig());
        this._pipelineSubMenu.menu.addMenuItem(editItem);

        const reloadItem = new PopupMenu.PopupMenuItem('Reload Config');
        reloadItem.connect('activate', () => {
            this._loadPipelineConfig();
            this._rebuildPipelineMenu();
        });
        this._pipelineSubMenu.menu.addMenuItem(reloadItem);
    }

    /* ---------------- claude-swap ---------------- */

    _findCswapPath() {
        let path = GLib.find_program_in_path('cswap');
        if (path) return path;
        path = GLib.find_program_in_path('claude-swap');
        if (path) return path;

        const home = GLib.get_home_dir();
        const candidatePaths = [
            `${home}/.local/bin/cswap`,
            `${home}/.local/bin/claude-swap`,
            `${home}/.local/share/uv/tools/claude-swap/bin/cswap`,
            `${home}/.cargo/bin/cswap`,
            '/usr/local/bin/cswap',
            '/usr/bin/cswap',
        ];
        for (const cand of candidatePaths) {
            if (GLib.file_test(cand, GLib.FileTest.EXISTS))
                return cand;
        }
        return null;
    }

    _runCswap(args, callback) {
        const cswapBin = this._findCswapPath();
        if (!cswapBin) {
            console.error('Claude Suite: cswap not found in PATH or common install locations');
            if (callback) callback(false, null, 'not-found');
            return;
        }
        try {
            const proc = new Gio.Subprocess({
                argv: [cswapBin, ...args],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [ok, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (callback) callback(ok, stdout, stderr);
                } catch (e) {
                    console.error(`Claude Suite (cswap) subprocess finish error: ${e.message}`);
                    if (callback) callback(false, null, e.message);
                }
            });
        } catch (e) {
            console.error(`Claude Suite (cswap) subprocess init error: ${e.message}`);
            if (callback) callback(false, null, e.message);
        }
    }

    _openTui() {
        try {
            const terminal = GLib.find_program_in_path('gnome-terminal') ||
                             GLib.find_program_in_path('ptyxis') ||
                             GLib.find_program_in_path('konsole') ||
                             GLib.find_program_in_path('xterm');
            const cswapBin = this._findCswapPath();
            if (terminal && cswapBin) {
                const proc = new Gio.Subprocess({ argv: [terminal, '--', cswapBin, 'tui'], flags: Gio.SubprocessFlags.NONE });
                proc.init(null);
            } else if (!cswapBin) {
                console.error('Claude Suite: cswap binary not found to launch TUI');
            }
        } catch (e) {
            console.error(`Claude Suite: failed to launch terminal for TUI: ${e.message}`);
        }
    }

    _refreshSwap() {
        this._runCswap(['list', '--json'], (ok, stdout, stderr) => {
            if (!ok || !stdout) {
                const notInstalled = stderr === 'not-found';
                this._label?.set_text(notInstalled ? 'Claude: Not installed' : 'Claude: Error');
                this._accountSubMenu?.label.set_text('Account: Error');
                if (this._activeHeader) {
                    const errDetail = notInstalled
                        ? 'cswap CLI not found — click below to install'
                        : (stderr ? stderr.split('\n')[0] : 'unknown error');
                    this._activeHeader.label.set_text(`Error: ${errDetail}`);
                }
                if (this._installItem) this._installItem.visible = notInstalled;
                this._fiveHourProgress.visible = false;
                this._sevenDayProgress.visible = false;
                this._accountsSection.removeAll();
                return;
            }

            if (this._installItem) this._installItem.visible = false;

            try {
                const data = JSON.parse(stdout);
                this._updateSwapUI(data);
            } catch (e) {
                console.error(`Claude Suite: failed to parse cswap json: ${e.message}`);
                this._label?.set_text('Claude: Error');
                this._accountSubMenu?.label.set_text('Account: Error');
                this._activeHeader?.label.set_text('Error: Invalid JSON from cswap');
                this._fiveHourProgress.visible = false;
                this._sevenDayProgress.visible = false;
                this._accountsSection.removeAll();
            }
        });
    }

    _updateSwapUI(data) {
        if (!data || !data.accounts) return;

        const activeAccount = data.accounts.find(a => a.active);

        if (activeAccount) {
            const displayLabel = activeAccount.alias || activeAccount.email.split('@')[0];
            let usageStr = '';
            if (activeAccount.usage && activeAccount.usage.fiveHour)
                usageStr = ` (${activeAccount.usage.fiveHour.pct}%)`;

            this._label.set_text(`Claude: ${displayLabel}${usageStr}`);
            this._accountSubMenu.label.set_text(`Account: ${displayLabel}${usageStr}`);
            this._activeHeader.label.set_text(`Active: ${activeAccount.email} (#${activeAccount.number})`);

            if (activeAccount.usage && activeAccount.usage.fiveHour) {
                this._fiveHourProgress.setProgress(activeAccount.usage.fiveHour.pct, activeAccount.usage.fiveHour.countdown || '');
                this._fiveHourProgress.visible = true;
            } else {
                this._fiveHourProgress.visible = false;
            }

            if (activeAccount.usage && activeAccount.usage.sevenDay) {
                this._sevenDayProgress.setProgress(activeAccount.usage.sevenDay.pct, activeAccount.usage.sevenDay.countdown || '');
                this._sevenDayProgress.visible = true;
            } else {
                this._sevenDayProgress.visible = false;
            }
        } else {
            this._label.set_text('Claude: None');
            this._accountSubMenu.label.set_text('Account: None');
            this._activeHeader.label.set_text('Active: None');
            this._fiveHourProgress.visible = false;
            this._sevenDayProgress.visible = false;
        }

        this._accountsSection.removeAll();
        for (const account of data.accounts) {
            const isCurrent = account.active;
            const menuItem = new AccountListItem(account, isCurrent, () => {
                if (!isCurrent) this._switchAccount(account.number);
            });
            this._accountsSection.addMenuItem(menuItem);
        }
    }

    _switchAccount(accountNum) {
        this._label.set_text(`Switching to #${accountNum}...`);
        this._runCswap(['switch', accountNum.toString(), '--json'], () => this._refreshSwap());
    }

    /* ---------------- claude-usage ---------------- */

    _usageScriptPath() {
        return GLib.build_filenamev([this.path, 'scripts', 'usage_stats.py']);
    }

    _refreshUsage(extraArgs = []) {
        try {
            const proc = new Gio.Subprocess({
                argv: ['python3', this._usageScriptPath(), ...extraArgs],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (!stdout) {
                        this._showUsageError(stderr || 'no output');
                        return;
                    }
                    const data = JSON.parse(stdout);
                    if (data.error) {
                        this._showUsageError(data.error);
                        return;
                    }
                    this._updateUsageUI(data);
                } catch (e) {
                    this._showUsageError(e.message);
                }
            });
        } catch (e) {
            this._showUsageError(e.message);
        }
    }

    _deleteUsageSession(sessionId) {
        this._refreshUsage(['--delete', sessionId]);
    }

    _showUsageError(msg) {
        console.error(`Claude Suite (usage): ${msg}`);
        this._usageSubMenu?.label.set_text('Usage: error');
        this._todayHeader?.label.set_text(`Error: ${msg.split('\n')[0]}`);
        this._weekHeader?.label.set_text('');
        this._tasksSection?.removeAll();
    }

    _updateUsageUI(data) {
        const today = data.today;
        const week = data.week;

        this._usageSubMenu.label.set_text(`Usage: ${fmtCost(today.cost_usd)} today`);

        this._todayHeader.label.set_text(
            `Today (${today.date}): ${today.sessions} sessions · ${fmtTokens(today.tokens)} tok · ${fmtCost(today.cost_usd)}`
        );

        this._tasksSection.removeAll();
        for (const task of today.tasks) {
            this._tasksSection.addMenuItem(
                new TaskListItem(task, sessionId => this._deleteUsageSession(sessionId))
            );
        }

        this._weekHeader.label.set_text(
            `Last 7 days: ${week.sessions} sessions · ${fmtTokens(week.tokens)} tok · ${fmtCost(week.cost_usd)}`
        );
    }

    /* ---------------- Recent Sessions ---------------- */

    _sessionsScriptPath() {
        return GLib.build_filenamev([this.path, 'scripts', 'list_sessions.py']);
    }

    _refreshSessions() {
        try {
            const proc = new Gio.Subprocess({
                argv: ['python3', this._sessionsScriptPath(), '--limit', '5'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (!stdout) {
                        this._showSessionsError(stderr || 'no output');
                        return;
                    }
                    const sessions = JSON.parse(stdout);
                    this._updateSessionsUI(sessions);
                } catch (e) {
                    this._showSessionsError(e.message);
                }
            });
        } catch (e) {
            this._showSessionsError(e.message);
        }
    }

    _showSessionsError(msg) {
        console.error(`Claude Suite (sessions): ${msg}`);
        this._sessionsListSection?.removeAll();
        this._sessionsListSection?.addMenuItem(
            new PopupMenu.PopupMenuItem(`Error: ${msg.split('\n')[0]}`, { reactive: false })
        );
    }

    _updateSessionsUI(sessions) {
        this._sessionsListSection.removeAll();
        if (!sessions || sessions.length === 0) {
            this._sessionsListSection.addMenuItem(
                new PopupMenu.PopupMenuItem('No recent sessions', { reactive: false })
            );
            return;
        }
        for (const session of sessions) {
            this._sessionsListSection.addMenuItem(
                new SessionListItem(session, s => this._resumeSession(s))
            );
        }
    }

    _resumeSession(session) {
        const cwd = expandPath(session.cwd);
        const argv = [this._config.terminal, `--working-directory=${cwd}`, '--', this._config.claudeBin, '--resume', session.session_id];
        this._spawnDetached(argv, cwd);
    }

    /* ---------------- claude-pipeline ---------------- */

    _loadPipelineConfig() {
        try {
            if (!GLib.file_test(CONFIG_PATH, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
                GLib.file_set_contents(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
            }
            const [ok, contents] = GLib.file_get_contents(CONFIG_PATH);
            if (ok) {
                const text = new TextDecoder('utf-8').decode(contents);
                this._config = { ...DEFAULT_CONFIG, ...JSON.parse(text) };
            }
        } catch (e) {
            logError(e, 'Claude Suite (pipeline): failed to load config');
            this._config = DEFAULT_CONFIG;
        }
    }

    _watchPipelineConfig() {
        const file = Gio.File.new_for_path(CONFIG_PATH);
        this._fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._fileMonitor.connect('changed', (_monitor, _file, _other, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                eventType === Gio.FileMonitorEvent.CREATED) {
                this._loadPipelineConfig();
                this._rebuildPipelineMenu();
            }
        });
    }

    _openPipelineConfig() {
        this._spawnDetached([this._config.editor, CONFIG_PATH]);
    }

    _openDashboard() {
        if (!this._dashboard) {
            this._dashboard = new PipelineDashboard(this);
            this._dashboard.connect('destroy', () => { this._dashboard = null; });
        } else {
            this._dashboard.refresh();
        }
        this._dashboard.open();
    }

    _runInTerminal(scenario) {
        const cwd = expandPath(scenario.cwd);
        const argv = [this._config.terminal, `--working-directory=${cwd}`, '--', this._config.claudeBin];
        for (const arg of scenario.args ?? []) argv.push(arg);
        if (scenario.prompt) argv.push(scenario.prompt);
        this._spawnDetached(argv, cwd);
    }

    _runInBackground(scenario) {
        const cwd = expandPath(scenario.cwd);
        const argv = [this._config.claudeBin, '-p', scenario.prompt ?? ''];
        for (const arg of scenario.args ?? []) argv.push(arg);

        const run = {
            id: ++this._runSeq,
            name: scenario.name,
            status: 'running',
            output: '',
            error: '',
            cancellable: new Gio.Cancellable(),
            outputPath: null,
            startTime: GLib.get_monotonic_time(),
            endTime: null,
        };
        this._runs.unshift(run);
        this._rebuildPipelineMenu();

        let proc;
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            launcher.set_cwd(cwd);
            proc = launcher.spawnv(argv);
        } catch (e) {
            run.status = 'failed';
            run.error = e.message;
            run.endTime = GLib.get_monotonic_time();
            this._rebuildPipelineMenu();
            this._notify('Claude Suite', `Failed to start "${scenario.name}": ${e.message}`, true);
            return;
        }

        proc.communicate_utf8_async(null, run.cancellable, (p, res) => {
            if (!this._enabled) {
                try { p.communicate_utf8_finish(res); } catch (_) { /* extension disabled before this run finished */ }
                return;
            }

            let stdout = '', stderr = '';
            try {
                [, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                run.endTime = GLib.get_monotonic_time();
                if (run.cancellable.is_cancelled()) {
                    run.status = 'failed';
                    run.error = 'Cancelled';
                    this._rebuildPipelineMenu();
                    this._updateTopBar();
                    return;
                }
                run.status = 'failed';
                run.error = e.message;
                this._rebuildPipelineMenu();
                this._updateTopBar();
                this._notify('Claude Suite', `"${scenario.name}" failed: ${e.message}`, true);
                return;
            }

            const success = p.get_successful();
            run.output = stdout ?? '';
            run.error = stderr ?? '';
            run.status = success ? 'done' : 'failed';
            run.endTime = GLib.get_monotonic_time();

            if (scenario.saveOutput && run.output) {
                try {
                    const outDir = expandPath(this._config.outputDir);
                    GLib.mkdir_with_parents(outDir, 0o755);
                    const fileName = `${slugify(scenario.name)}-${timestamp()}.md`;
                    const outPath = GLib.build_filenamev([outDir, fileName]);
                    GLib.file_set_contents(outPath, run.output);
                    run.outputPath = outPath;
                } catch (e) {
                    logError(e, 'Claude Suite (pipeline): failed to save output');
                }
            }

            this._rebuildPipelineMenu();
            this._updateTopBar();
            this._notify(
                'Claude Suite',
                success ? `"${scenario.name}" finished.` : `"${scenario.name}" failed.`,
                !success
            );
        });

        this._updateTopBar();
    }

    _cancelRun(run) {
        run.cancellable?.cancel();
    }

    _openRunOutput(run) {
        if (run.outputPath) {
            this._spawnDetached([this._config.editor, run.outputPath]);
            return;
        }
        if (!run.output && !run.error) {
            this._notify('Claude Suite', 'No output captured for this run.');
            return;
        }
        try {
            const outDir = GLib.build_filenamev([GLib.get_tmp_dir(), 'claude-pipeline']);
            GLib.mkdir_with_parents(outDir, 0o755);
            const tmpPath = GLib.build_filenamev([outDir, `${slugify(run.name)}-${run.id}.md`]);
            GLib.file_set_contents(tmpPath, run.output || run.error);
            this._spawnDetached([this._config.editor, tmpPath]);
        } catch (e) {
            this._notify('Claude Suite', `Could not open output: ${e.message}`, true);
        }
    }

    _runScenario(scenario) {
        if (scenario.mode === 'terminal')
            this._runInTerminal(scenario);
        else
            this._runInBackground(scenario);
    }

    _rebuildPipelineMenu() {
        if (!this._enabled) return;
        if (!this._scenariosSection || !this._runsSection || !this._runningSection) return;

        this._scenariosSection.removeAll();
        const scenarios = this._config.scenarios ?? [];
        if (scenarios.length > 0) {
            for (const scenario of scenarios) {
                const modeTag = scenario.mode === 'terminal' ? ' (terminal)' : '';
                const item = new PopupMenu.PopupMenuItem(`${scenario.name}${modeTag}`);
                item.connect('activate', () => this._runScenario(scenario));
                this._scenariosSection.addMenuItem(item);
            }
        } else {
            this._scenariosSection.addMenuItem(new PopupMenu.PopupMenuItem('No scenarios configured', { reactive: false }));
        }

        const runningRuns = this._runs.filter(r => r.status === 'running');
        const finishedRuns = this._runs.filter(r => r.status !== 'running');

        this._runningSection.removeAll();
        if (runningRuns.length > 0) {
            for (const run of runningRuns) {
                this._runningSection.addMenuItem(new RunListItem(
                    run,
                    r => this._openRunOutput(r),
                    r => this._cancelRun(r)
                ));
            }
        } else {
            this._runningSection.addMenuItem(new PopupMenu.PopupMenuItem('No pipelines running', { reactive: false }));
        }

        this._runsSection.removeAll();
        for (const run of finishedRuns.slice(0, 8)) {
            this._runsSection.addMenuItem(new RunListItem(
                run,
                r => this._openRunOutput(r),
                r => this._cancelRun(r)
            ));
        }

        if (this._pipelineSubMenu) {
            this._pipelineSubMenu.label.text = runningRuns.length > 0
                ? `Pipeline (${runningRuns.length} running)`
                : 'Pipeline';
        }

        this._dashboard?.refresh();
        this._updateTopBar();
    }
}
