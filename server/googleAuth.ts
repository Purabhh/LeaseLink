import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import session from "express-session";
import type { Express, RequestHandler } from "express";
import connectPg from "connect-pg-simple";
import { storage } from "./storage";

// For development, use dummy values if credentials are not set
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'dummy-client-id';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'dummy-client-secret';

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn("⚠️  Google OAuth credentials not found. Using dummy values for development.");
  console.warn("   Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for production.");
}

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  
  return session({
    secret: process.env.SESSION_SECRET || 'your-session-secret-here',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: sessionTtl,
    },
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // Google OAuth Strategy
  let callbackURL = "/api/auth/google/callback";
  
  // Handle different deployment environments
  if (process.env.GOOGLE_CALLBACK_URL) {
    // Explicit override always wins
    callbackURL = process.env.GOOGLE_CALLBACK_URL;
  } else if (process.env.REPLIT_DEV_DOMAIN) {
    // Replit development environment
    callbackURL = `https://${process.env.REPLIT_DEV_DOMAIN}/api/auth/google/callback`;
  } else if (process.env.RAILWAY_STATIC_URL) {
    // Railway deployment environment - add https:// protocol
    callbackURL = `https://${process.env.RAILWAY_STATIC_URL}/api/auth/google/callback`;
  } else if (process.env.NODE_ENV === 'production' && process.env.VERCEL_URL) {
    // Vercel deployment environment
    callbackURL = `https://${process.env.VERCEL_URL}/api/auth/google/callback`;
  } else if (process.env.CUSTOM_DOMAIN) {
    // Custom domain environment
    callbackURL = `https://${process.env.CUSTOM_DOMAIN}/api/auth/google/callback`;
  }
  
  console.log(`🔗 OAuth callback URL configured: ${callbackURL}`);
    
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: callbackURL
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value || '';
      
      // First, try to find existing user by email
      let user = await storage.getUserByEmail(email);
      
      if (user) {
        // User exists, update their Google profile info
        const updatedUser = await storage.updateUserProfile(user.id, {
          firstName: profile.name?.givenName || user.firstName,
          lastName: profile.name?.familyName || user.lastName,
          profileImageUrl: profile.photos?.[0]?.value || user.profileImageUrl,
        });
        return done(null, updatedUser);
      } else {
        // New user, create with Google profile data
        const userData = {
          id: profile.id,
          email: email,
          firstName: profile.name?.givenName || '',
          lastName: profile.name?.familyName || '',
          profileImageUrl: profile.photos?.[0]?.value || null,
        };
        
        const newUser = await storage.upsertUser(userData);
        return done(null, newUser);
      }
    } catch (error) {
      console.error('Google OAuth error:', error);
      return done(error, undefined);
    }
  }));

  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error, null);
    }
  });

  // Auth routes
  app.get("/api/auth/google",
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get("/api/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login-failed" }),
    (req, res) => {
      // Successful authentication, redirect to home
      res.redirect("/");
    }
  );

  app.get("/api/logout", (req, res) => {
    req.logout((err) => {
      if (err) {
        return res.status(500).json({ message: "Logout failed" });
      }
      res.redirect("/");
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};