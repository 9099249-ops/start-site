import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import main

class NetworkTests(unittest.TestCase):
    def test_reports_changed_lan_addresses_without_loopback_or_vpn(self):
        def interface(name, ip):
            return {'ifname': name, 'addr_info': [{'local': ip, 'scope': 'global'}]}
        rows = [interface('lo', '127.0.0.1'), interface('wlan0', '192.168.1.150'),
                interface('eth0', '10.0.0.5'), interface('docker0', '172.17.0.1'),
                interface('tailscale0', '100.64.0.10')]
        with patch.object(main.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(rows))):
            self.assertEqual(main.local_network(), {'local_ip': '10.0.0.5', 'local_ips': ['10.0.0.5', '192.168.1.150']})
        rows[1]['addr_info'][0]['local'] = '192.168.1.151'
        with patch.object(main.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(rows[1:2]))):
            self.assertEqual(main.local_network()['local_ip'], '192.168.1.151')

    def test_network_inspection_failure_does_not_stop_printing(self):
        with patch.object(main.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ip', 2)):
            self.assertEqual(main.local_network(), {'local_ip': None, 'local_ips': []})

if __name__ == '__main__': unittest.main()
