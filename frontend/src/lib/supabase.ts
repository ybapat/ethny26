import { createClient } from "@supabase/supabase-js";

const URL = "https://jvlpoqqabzqipmzdsiel.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2bHBvcXFhYnpxaXBtemRzaWVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMjI4NjgsImV4cCI6MjA5ODY5ODg2OH0.AWIvVilTjMf5qEMSPEcWNhaqBC0m4mkPZDrXEPEfk08";

export const supabase = createClient(URL, ANON_KEY);
