import datetime as dt
import tempfile
import unittest
from pathlib import Path
from trigger import API, trigger, TriggerError


class TriggerTest(unittest.TestCase):
    def test_workflow_correlation_and_repository(self):
        self.assertEqual(API, 'https://api.github.com/repos/liristy/nesc_scanner/actions/workflows/daily-report.yml')
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/daily-report.yml').read_text(encoding='utf-8')
        self.assertIn("run-name: ${{ inputs.trigger_id || 'JY 每日监测报告' }}", workflow)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / 'last-trigger.json'
        self.now = dt.datetime.fromisoformat('2026-10-02T16:00:00+08:00')
        self.runs, self.posts = [], []

    def run_record(self, title):
        return {'id': 123, 'display_title': title, 'event': 'workflow_dispatch',
                'head_branch': 'main', 'status': 'queued', 'html_url': 'https://github.com/example/run/123'}

    def api(self, method, suffix, payload=None):
        if method == 'POST':
            self.posts.append(payload)
            self.runs.append(self.run_record(payload['inputs']['trigger_id']))
            return {}
        return {'workflow_runs': self.runs}

    def test_dispatch_confirm_and_no_duplicate(self):
        self.assertEqual(trigger(self.api, self.state, self.now)['id'], 123)
        trigger(self.api, self.state, self.now)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0], {'ref': 'main', 'inputs': {'trigger_id': 'nesc-server-2026-10-02'}})

    def test_remote_match_survives_local_state_loss(self):
        self.runs.append(self.run_record('nesc-server-2026-10-02'))
        trigger(self.api, self.state, self.now)
        self.assertEqual(self.posts, [])

    def test_other_manual_run_does_not_count_as_ours(self):
        self.runs.append(self.run_record('JY 每日监测报告'))
        trigger(self.api, self.state, self.now)
        self.assertEqual(len(self.posts), 1)

    def test_uncertain_dispatch_does_not_resend(self):
        def uncertain(method, suffix, payload=None):
            if method == 'POST':
                self.posts.append(payload)
                raise TriggerError('network timeout')
            return {'workflow_runs': []}
        with self.assertRaises(TriggerError):
            trigger(uncertain, self.state, self.now)
        with self.assertRaises(TriggerError):
            trigger(uncertain, self.state, self.now, sleep=lambda _: None, attempts=2)
        self.assertEqual(len(self.posts), 1)

    def test_reboot_before_cutoff_uses_last_due_day(self):
        trigger(self.api, self.state, self.now.replace(hour=10))
        self.assertEqual(self.posts[0]['inputs']['trigger_id'], 'nesc-server-2026-10-01')

    def test_next_day_can_dispatch(self):
        trigger(self.api, self.state, self.now)
        trigger(self.api, self.state, self.now + dt.timedelta(days=1))
        self.assertEqual(len(self.posts), 2)

    def test_four_pm_cutoff_and_timezone(self):
        for text, expected in [
            ('2026-10-02T15:59:59+08:00', '2026-10-01'),
            ('2026-10-02T07:59:59+00:00', '2026-10-01'),
            ('2026-10-02T16:00:00+08:00', '2026-10-02'),
            ('2026-10-02T08:00:00+00:00', '2026-10-02'),
            ('2026-10-02T16:30:00+08:00', '2026-10-02'),
            ('2026-10-02T08:30:00+00:00', '2026-10-02'),
        ]:
            with self.subTest(text=text):
                self.posts, self.runs = [], []
                state = self.state.with_name('boundary-' + expected + '.json')
                state.unlink(missing_ok=True)
                trigger(self.api, state, dt.datetime.fromisoformat(text))
                self.assertEqual(self.posts[0]['inputs']['trigger_id'], 'nesc-server-' + expected)


if __name__ == '__main__':
    unittest.main()
