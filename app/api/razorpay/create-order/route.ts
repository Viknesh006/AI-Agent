import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import Razorpay from "razorpay";
import { PRICING_PLANS } from "@/lib/constants";

function getRazorpayClient() {
  const keyId = (process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? process.env.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET ?? "").trim();
  if (!keyId || !keySecret) {
    throw new Error("Razorpay credentials are not configured in environment variables.");
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export async function POST(req: NextRequest) {
  try {
    const razorpay = getRazorpayClient();
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { planKey } = body as { planKey: string };

    const plan = PRICING_PLANS.find((p) => p.key === planKey);
    if (!plan || plan.razorpayPrice === 0) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    // Razorpay amounts are in the smallest currency unit (paise for INR)
    const amountInPaise = plan.razorpayPrice * 100;

    // receipt must be ≤ 40 chars
    const shortId = userId.slice(-8);
    const ts = Date.now().toString().slice(-8);
    const receipt = `rzp_${shortId}_${planKey}_${ts}`; // max ~28 chars

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt,
      notes: {
        userId,
        planKey,
      },
    });

    return NextResponse.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (error) {
    console.error("Razorpay create-order error:", error);
    return NextResponse.json(
      { error: "Failed to create order" },
      { status: 500 }
    );
  }
}
