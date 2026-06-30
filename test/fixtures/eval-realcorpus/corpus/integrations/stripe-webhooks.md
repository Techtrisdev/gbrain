# Integration: setting up Stripe webhooks

Receive payment events from Stripe and verify they are authentic before acting on them.

1. In the Stripe dashboard, add a webhook endpoint pointing at `/webhooks/stripe` and
   subscribe to the events you need (`checkout.session.completed`,
   `invoice.payment_failed`, etc.).
2. Copy the endpoint's signing secret and store it in the secrets manager as
   `STRIPE_WEBHOOK_SECRET`.
3. In the handler, read the raw request body and the `Stripe-Signature` header, then call
   the SDK's `constructEvent(body, signature, secret)` to verify the signature. Reject
   anything that fails verification with a 400.
4. Return a 2xx quickly and process the event asynchronously so Stripe doesn't retry on
   a slow handler.
5. Use the Stripe CLI's `stripe listen --forward-to` to replay events against your local
   environment while developing.
