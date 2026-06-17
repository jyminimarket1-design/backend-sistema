import { z } from 'zod';

export const createUserSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format").min(1, "Email is required"),
    password: z.string().min(6, "Password must be at least 6 characters long"),
    name: z.string().min(1, "Name is required"),
    role: z.enum(['admin', 'customer']).optional()
  })
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format").min(1, "Email is required"),
    password: z.string().min(1, "Password is required")
  })
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format").min(1, "Email is required")
  })
});

export const resetPasswordSchema = z.object({
  params: z.object({
    token: z.string().min(1, "Token is required")
  }),
  body: z.object({
    password: z.string().min(6, "Password must be at least 6 characters long")
  })
});
