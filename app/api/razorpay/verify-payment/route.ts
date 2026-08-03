import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import crypto from "crypto";
import { db } from "@/lib/prisma";
import { PLANS } from "@/lib/constants";
import type { Plan } from "@/types/plans";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      planKey,
    } = body as {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      planKey: string;
    };

    // Verify HMAC-SHA256 signature
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (generatedSignature !== razorpay_signature) {
      return NextResponse.json(
        { error: "Invalid payment signature" },
        { status: 400 }
      );
    }

    const newPlan = planKey as Plan;
    const newPlanData = PLANS[newPlan];
    if (!newPlanData) {
      return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
    }

    // Get existing user
    const user = await db.user.findUnique({ where: { clerkId: userId } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const existingPlanCredits = PLANS[user.plan as Plan]?.credits ?? 0;
    const newPlanCredits = newPlanData.credits;
    const creditDelta = newPlanCredits - existingPlanCredits;

    // Update user plan and credits
    await db.user.update({
      where: { clerkId: userId },
      data: {
        plan: newPlan,
        credits: creditDelta > 0 ? user.credits + creditDelta : user.credits,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Razorpay verify-payment error:", error);
    return NextResponse.json(
      { error: "Failed to verify payment" },
      { status: 500 }
    );
  }
}
