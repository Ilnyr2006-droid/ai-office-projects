# Car Store MVP Backend

Минимальный backend для MVP магазина автомобилей.

## Запуск

```bash
cp .env.example .env
python3 run.py
```

## Что есть

- Публичный каталог автомобилей с фильтрами
- Карточка автомобиля
- Создание заявки на покупку / кредит / trade-in / тест-драйв
- Админский CRUD для автомобилей по заголовку `X-API-Token`
- Список заявок для админа

## Основные маршруты

- `GET /health`
- `GET /api/cars`
- `GET /api/cars/{id}`
- `POST /api/cars/{id}/inquiries`
- `GET /api/admin/inquiries`
- `POST /api/admin/cars`
- `PUT /api/admin/cars/{id}`
- `DELETE /api/admin/cars/{id}`
