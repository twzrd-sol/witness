# Seller HTTP error contract

POST /seller/offer/validate accepts a bare seller-offer/v1 offer or {offer,outcomes?}. Success returns {success:true,data:{seller_card},request_metadata}.

- Unparseable JSON returns HTTP 400 with bad_json.
- Parseable JSON with an invalid offer shape returns HTTP 400 with bad_seller_offer.
- A supplied outcomes value that is not an array returns HTTP 400 with bad_outcomes (checked before offer validation).
- Missing/empty history keeps approval_rate, refund_rate and median_delivery_minutes null. It is not evidence of trustworthiness.

The route is pure over caller-supplied input. A board must supply its own persisted outcome rows over HTTP and authenticate who may record outcomes. A seller card alone does not prove delivery or payment.

Source: src/routes/seller.js, src/seller.js and the host JSON error handler in src/server.js.
