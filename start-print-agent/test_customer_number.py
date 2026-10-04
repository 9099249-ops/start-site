import copy
import unittest
from unittest.mock import patch
import main
from tests import ORDER

class CustomerNumberTests(unittest.TestCase):
    def test_customer_number_and_plain_header(self):
        for ident,expected in [(1,'001'),(127,'127'),(998,'998'),(999,'999'),(1000,'001'),(1001,'002')]:
            data=copy.deepcopy(ORDER);data['order_number']=str(ident)
            _,_,data=main.validate(data)
            before=copy.deepcopy(data)
            lines=main.receipt_lines(data,'2026-10-03T07:00:00+03:00')
            self.assertEqual(lines[:3],['КАФЕ СТАРТ','',expected])
            self.assertNotIn('ЗАКАЗ',lines)
            self.assertEqual(data,before)
    def test_special_tickets_stay_distinct(self):
        for kind,caption in [('ADD','ДОЗАКАЗ'),('CANCELLED','ОТМЕНА ЗАКАЗА'),('LOCATION','УТОЧНЕНИЕ МЕСТА')]:
            data=copy.deepcopy(ORDER);data.update(order_number='1000',ticket_kind=kind)
            _,_,data=main.validate(data)
            lines=main.receipt_lines(data,'2026-10-03T07:00:00+03:00',True)
            self.assertEqual(lines[4:6],[caption,'001'])
            self.assertIn('*** ПОВТОР ***',lines)

if __name__=='__main__':unittest.main()
