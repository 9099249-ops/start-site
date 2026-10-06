import copy
from pathlib import Path
import unittest

import main
from tests import ORDER


class DiscountReceiptTests(unittest.TestCase):
    def make_order(self, created='2026-10-05T12:00:00+03:00', total='2000.01', **extra):
        data = copy.deepcopy(ORDER)
        data.update(order_created_at=created, order_total=total, **extra)
        return main.validate(data)[2]

    def test_weekday_windows(self):
        cases = [
            ('2026-10-05T12:00:00+03:00', 'с 06.10 по 08.10.2026'),
            ('2026-10-06T12:00:00+03:00', 'с 07.10 по 08.10.2026'),
            ('2026-10-07T12:00:00+03:00', '08.10.2026'),
            ('2026-10-08T12:00:00+03:00', 'с 12.10 по 15.10.2026'),
            ('2026-10-09T12:00:00+03:00', 'с 12.10 по 15.10.2026'),
            ('2026-10-10T12:00:00+03:00', 'с 12.10 по 15.10.2026'),
            ('2026-10-11T12:00:00+03:00', 'с 12.10 по 15.10.2026'),
        ]
        for created, expected in cases:
            with self.subTest(created=created):
                self.assertEqual(main.promotion_lines(self.make_order(created))[-1], 'Действует: ' + expected)

    def test_threshold_and_optional_pair(self):
        for total in ('1999.99', '2000', '2000.00'):
            data = self.make_order(total=total)
            self.assertEqual(main.promotion_lines(data), [])
        self.assertTrue(main.promotion_lines(self.make_order(total='2000.01')))
        for key in ('order_created_at', 'order_total'):
            data = self.make_order()
            del data[key]
            self.assertEqual(main.promotion_lines(data), [])
            data[key] = self.make_order()[key]
            del data['order_total' if key == 'order_created_at' else 'order_created_at']
            with self.assertRaises(ValueError):
                main.validate(data)

    def test_timezone_boundary_uses_moscow_date(self):
        data = self.make_order('2026-10-04T21:30:00Z')  # Monday in Moscow.
        self.assertEqual(main.promotion_lines(data)[-1], 'Действует: с 06.10 по 08.10.2026')
        year_boundary = self.make_order('2026-12-31T12:00:00+03:00')
        self.assertEqual(main.promotion_lines(year_boundary)[-1],
                         'Действует: с 04.01 по 07.01.2027')
        spanning_years = self.make_order('2025-12-29T12:00:00+03:00')
        self.assertEqual(main.promotion_lines(spanning_years)[-1],
                         'Действует: с 30.12.2025 по 01.01.2026')
        prior_year = self.make_order('2026-12-30T12:00:00+03:00')
        self.assertEqual(main.promotion_lines(prior_year)[-1], 'Действует: 31.12.2026')

    def test_legacy_reprint_and_ticket_kinds(self):
        data = copy.deepcopy(ORDER)
        self.assertEqual(main.promotion_lines(data), [])
        data.update(order_created_at='2026-10-07T12:00:00+03:00', order_total='2001.00')
        data = main.validate(data)[2]
        self.assertTrue(main.promotion_lines(data))
        self.assertEqual(main.promotion_lines(dict(data, ticket_kind='ADD'))[-1], 'Действует: 08.10.2026')
        for kind in ('CANCELLED', 'LOCATION'):
            self.assertEqual(main.promotion_lines(dict(data, ticket_kind=kind)), [])
        self.assertEqual(main.promotion_lines({**data, 'type': 'shift_report'}), [])
        self.assertEqual(main.receipt_lines(data, '2026-10-07T09:00:00+03:00', True)[-5:], main.promotion_lines(data))
        self.assertEqual(main.receipt_lines(data, '2027-01-15T20:00:00+03:00', True)[-5:], main.promotion_lines(data))

    def test_optional_fields_validate_without_normalizing_or_hash_changes(self):
        data = self.make_order('2026-10-05T09:00:00Z', '2000.01')
        before = copy.deepcopy(data)
        before_hash = main.payload_hash({key: data[key] for key in ('order_created_at', 'order_total')})
        _, _, normalized = main.validate(data)
        self.assertEqual(data, before)
        self.assertEqual(normalized['order_created_at'], before['order_created_at'])
        self.assertEqual(normalized['order_total'], before['order_total'])
        self.assertEqual(main.payload_hash({key: normalized[key] for key in ('order_created_at', 'order_total')}), before_hash)
        for created, total in [('2026-10-05T12:00:00', '2001'), ('bad', '2001'),
                               ('2026-10-05T12:00:00Z', 2001)]:
            with self.subTest(created=created, total=total), self.assertRaises(ValueError):
                main.validate(self.make_order(created, total))

    def test_raster_geometry_and_no_horizontal_crop(self):
        from PIL import Image
        data = self.make_order('2026-10-05T12:00:00+03:00', '2001')
        windows_font = Path('C:/Windows/Fonts/arial.ttf')
        cfg = ({'font_path': str(windows_font), 'bold_font_path': 'C:/Windows/Fonts/arialbd.ttf'}
               if windows_font.exists() else
               {'font_path': '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                'bold_font_path': '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'})
        for width in (384, 448, 576, 640):
            bands = list(main.receipt_bands(data, '2026-10-05T12:00:00+03:00', {**cfg, 'width_dots': width}))
            self.assertTrue(bands)
            self.assertTrue(all(band.width == width for band in bands))
            for band in bands:
                bbox = band.convert('L').point(lambda value: 255 if value < 128 else 0).getbbox()
                if bbox:
                    self.assertGreaterEqual(bbox[0], 4)
                    self.assertLessEqual(bbox[2], width - 4)
        plain = main.validate(copy.deepcopy(ORDER))[2]
        self.assertIn('ИТОГО: ' + plain['total'] + ' ₽', main.receipt_lines(plain, '2026-10-05T12:00:00+03:00'))


if __name__ == '__main__':
    unittest.main()
