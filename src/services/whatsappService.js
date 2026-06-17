export function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

export function generateWhatsAppLink(phone, message) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return "";
  }

  return `https://wa.me/${normalizedPhone}?text=${encodeURIComponent(message || "")}`;
}
