import pg from "pg";
import { Contact, ContactStage, rowToContact } from "./campaigns.repo.js";

export type NewContact = {
  campaignId: string;
  name: string;
  phoneDigits: string;
  city?: string | null;
  refId?: string | null;
  stage?: ContactStage;
  invalidReason?: string | null;
};

export class ContactsRepo {
  constructor(private pool: pg.Pool) {}

  // Upload is idempotent per (campaign, phone): a re-uploaded row updates the
  // name/city instead of erroring, so an operator can fix a typo and re-upload
  // without the campaign ending up with two records for one person.
  async upsert(c: NewContact): Promise<Contact> {
    const { rows } = await this.pool.query(
      `INSERT INTO campaign_contacts(campaign_id,name,phone_digits,city,ref_id,stage,invalid_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (campaign_id, phone_digits) DO UPDATE
         SET name=EXCLUDED.name, city=EXCLUDED.city, ref_id=EXCLUDED.ref_id, updated_at=now()
       RETURNING *`,
      [
        c.campaignId,
        c.name,
        c.phoneDigits,
        c.city ?? null,
        c.refId ?? null,
        c.stage ?? "UPLOADED",
        c.invalidReason ?? null,
      ],
    );
    return rowToContact(rows[0]);
  }

  async get(id: string): Promise<Contact | null> {
    const { rows } = await this.pool.query(`SELECT * FROM campaign_contacts WHERE id=$1`, [id]);
    return rows[0] ? rowToContact(rows[0]) : null;
  }

  async listByCampaign(campaignId: string, stages?: ContactStage[]): Promise<Contact[]> {
    const { rows } = stages?.length
      ? await this.pool.query(
          `SELECT * FROM campaign_contacts WHERE campaign_id=$1 AND stage = ANY($2) ORDER BY created_at`,
          [campaignId, stages],
        )
      : await this.pool.query(
          `SELECT * FROM campaign_contacts WHERE campaign_id=$1 ORDER BY created_at`,
          [campaignId],
        );
    return rows.map(rowToContact);
  }

  async setStage(id: string, stage: ContactStage): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_contacts SET stage=$2, updated_at=now() WHERE id=$1`,
      [id, stage],
    );
  }

  async setDisposition(
    id: string,
    d: { stage: ContactStage; note?: string | null; ownerAgent?: string | null },
  ): Promise<Contact | null> {
    const { rows } = await this.pool.query(
      `UPDATE campaign_contacts
          SET stage=$2,
              note=COALESCE($3, note),
              owner_agent=COALESCE($4, owner_agent),
              updated_at=now()
        WHERE id=$1 RETURNING *`,
      [id, d.stage, d.note ?? null, d.ownerAgent ?? null],
    );
    return rows[0] ? rowToContact(rows[0]) : null;
  }

  async assign(id: string, ownerAgent: string): Promise<void> {
    await this.pool.query(
      `UPDATE campaign_contacts SET owner_agent=$2, updated_at=now() WHERE id=$1`,
      [id, ownerAgent],
    );
  }

  // Inbound WhatsApp resolves a sender to the contact behind their newest live
  // leg-1 attempt. Digits alone are not enough: the same number could appear in
  // an older, finished campaign. Compared on the last 10 digits because an
  // uploaded sheet may or may not carry the country code.
  async findLiveByPhone(phoneDigits: string): Promise<Contact | null> {
    const { rows } = await this.pool.query(
      `SELECT c.* FROM campaign_contacts c
         JOIN campaign_attempts a ON a.contact_id = c.id
        WHERE right(c.phone_digits, 10) = right($1, 10)
          AND a.leg=1
          AND a.status IN ('QUEUED','DIALING','IN_PROGRESS')
        ORDER BY a.created_at DESC LIMIT 1`,
      [phoneDigits],
    );
    return rows[0] ? rowToContact(rows[0]) : null;
  }
}
