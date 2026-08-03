import arcjet, { detectBot, shield } from "@arcjet/next";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const isProtectedRoute = createRouteMatcher([
  "/workspace(.*)",
  "/projects(.*)",
]);

// ─── Global Arcjet client ─────────────────────────────────────────────────────
// Runs on every request. Looser than the route-level client — allows search
// engines and link previews so the landing page gets indexed and
// Slack/Twitter unfurls work.

const arcjetKey = (process.env.ARCJET_KEY ?? "").trim();

const aj = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        shield({ mode: "LIVE" }),
        detectBot({
          mode: "LIVE",
          allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:PREVIEW"],
        }),
      ],
    })
  : null;

export default clerkMiddleware(async (auth, req) => {
  if (aj) {
    const decision = await aj.protect(req);
    if (decision.isDenied()) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Clerk auth guard — redirect unauthenticated users away from /workspace
  const { userId } = await auth();

  if (!userId && isProtectedRoute(req)) {
    const { redirectToSignIn } = await auth();
    return redirectToSignIn();
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
