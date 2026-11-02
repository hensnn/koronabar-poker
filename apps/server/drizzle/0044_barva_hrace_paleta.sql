-- Barva hráče je teď kód 1 až 60 (odstín a tón); dříve přidělené hodnoty 1 až 12 se zahazují (automatické barvy).
UPDATE "users" SET "chart_color" = NULL;
