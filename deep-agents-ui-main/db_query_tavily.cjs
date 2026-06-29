const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  "https://tlqmrqgjrmbhdvlxalqv.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRscW1ycWdqcm1iaGR2bHhhbHF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwNzc1MTIsImV4cCI6MjA4NjY1MzUxMn0.cuhOYU-JLPiqifJKa4hK_J__beu2ORV_OwVZV8bydLg"
);

async function main() {
  const { data, error } = await supabase
    .from("mcp_connections")
    .select("*");
  
  if (error) {
    console.error("DB Error:", error);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

main();
