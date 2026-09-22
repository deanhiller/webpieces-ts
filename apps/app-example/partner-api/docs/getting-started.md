# Getting started

Every call is a `POST` of JSON to `https://api.example.com`, and every response is JSON. There are no
query parameters and no path parameters: the request body carries everything, which is what makes an
operation's published schema the complete description of what you may send.

Read one store's orders, then act on one of them:

```bash
curl https://api.example.com/orders/fetch \
  -H 'x-api-key: <your PartnerApiKey>' \
  -H 'x-organization-id: <your PartnerOrganization>' \
  -H 'content-type: application/json' \
  -d '{"storeId": "store-17"}'
```

## What to build against

The reference in the sidebar is generated from the running contract, so the fields it lists are the
fields the server reads. Where this guide and the reference disagree, the reference is right — it
cannot drift, and this page can.

| you want | read |
|---|---|
| the orders in a window | **fetchOrders** |
| to stop an order | **cancelOrder** |
| to be told when something changes | **Receiving webhooks** |
