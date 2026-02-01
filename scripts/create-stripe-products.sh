#!/bin/bash
# Create GitClawLab Stripe products and prices

STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"

if [ -z "$STRIPE_SECRET_KEY" ]; then
  echo "Error: Set STRIPE_SECRET_KEY first"
  echo "  export STRIPE_SECRET_KEY=sk_test_xxx"
  exit 1
fi

API="https://api.stripe.com/v1"
AUTH="-u $STRIPE_SECRET_KEY:"

echo "Creating GitClawLab Pro product..."
PRO_PRODUCT=$(curl -s $API/products $AUTH \
  -d "name=GitClawLab Pro" \
  -d "description=Unlimited repositories, unlimited deployments, priority support, custom domains" \
  -d "metadata[plan_type]=pro")

PRO_PRODUCT_ID=$(echo "$PRO_PRODUCT" | jq -r '.id')
echo "Pro Product ID: $PRO_PRODUCT_ID"

echo "Creating Pro price ($20/month)..."
PRO_PRICE=$(curl -s $API/prices $AUTH \
  -d "product=$PRO_PRODUCT_ID" \
  -d "unit_amount=2000" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[plan_type]=pro")

PRO_PRICE_ID=$(echo "$PRO_PRICE" | jq -r '.id')
echo "Pro Price ID: $PRO_PRICE_ID"

echo ""
echo "Creating GitClawLab Team product..."
TEAM_PRODUCT=$(curl -s $API/products $AUTH \
  -d "name=GitClawLab Team" \
  -d "description=Everything in Pro plus 5 agent seats, team permissions, audit logs" \
  -d "metadata[plan_type]=team")

TEAM_PRODUCT_ID=$(echo "$TEAM_PRODUCT" | jq -r '.id')
echo "Team Product ID: $TEAM_PRODUCT_ID"

echo "Creating Team price ($50/month)..."
TEAM_PRICE=$(curl -s $API/prices $AUTH \
  -d "product=$TEAM_PRODUCT_ID" \
  -d "unit_amount=5000" \
  -d "currency=usd" \
  -d "recurring[interval]=month" \
  -d "metadata[plan_type]=team")

TEAM_PRICE_ID=$(echo "$TEAM_PRICE" | jq -r '.id')
echo "Team Price ID: $TEAM_PRICE_ID"

echo ""
echo "=========================================="
echo "Done! Set these on Railway:"
echo ""
echo "railway variables set \"STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY\" --service cheerful-cooperation"
echo "railway variables set \"STRIPE_PRO_PRICE_ID=$PRO_PRICE_ID\" --service cheerful-cooperation"
echo "railway variables set \"STRIPE_TEAM_PRICE_ID=$TEAM_PRICE_ID\" --service cheerful-cooperation"
echo ""
echo "Then redeploy:"
echo "railway up --service cheerful-cooperation"
