import { z } from "zod";

const linkSchema=z.string().trim().max(300).refine(value=>value.startsWith("/")||/^https:\/\//.test(value),"Use an internal path or HTTPS URL");
const campaignBase=z.object({id:z.string().uuid(),name:z.string().trim().min(2).max(100),enabled:z.boolean(),startsAt:z.string().datetime().or(z.literal("")),endsAt:z.string().datetime().or(z.literal("")),audience:z.enum(["ALL","NEW_VISITORS","RETURNING_VISITORS"])}).refine(value=>!value.startsAt||!value.endsAt||new Date(value.endsAt)>new Date(value.startsAt),{message:"End time must follow start time"});
export const promotionConfigSchema=z.object({
  welcomePopupEnabled:z.boolean().default(true),
  announcementBars:z.array(campaignBase.and(z.object({message:z.string().trim().min(2).max(180),buttonLabel:z.string().trim().max(40),buttonUrl:linkSchema,backgroundColor:z.string().regex(/^#[0-9a-fA-F]{6}$/),textColor:z.string().regex(/^#[0-9a-fA-F]{6}$/)}))).max(8),
  banners:z.array(campaignBase.and(z.object({eyebrow:z.string().trim().max(60),headline:z.string().trim().min(2).max(120),body:z.string().trim().max(240),buttonLabel:z.string().trim().min(1).max(40),buttonUrl:linkSchema,imageUrl:z.union([z.string().url().max(1000),z.literal("")]),placement:z.enum(["HOME_HERO","HOME_INLINE","SHOP_TOP"]),backgroundColor:z.string().regex(/^#[0-9a-fA-F]{6}$/)}))).max(12),
  popups:z.array(campaignBase.and(z.object({headline:z.string().trim().min(2).max(100),body:z.string().trim().max(240),couponCode:z.string().trim().toUpperCase().max(40),buttonLabel:z.string().trim().min(1).max(40),buttonUrl:linkSchema,delaySeconds:z.number().int().min(0).max(120),frequency:z.enum(["ONCE","DAILY","EVERY_VISIT"])}))).max(8),
});
export type PromotionConfig=z.infer<typeof promotionConfigSchema>;
export const defaultPromotionConfig:PromotionConfig={welcomePopupEnabled:true,announcementBars:[],banners:[{id:"5d2fb2ae-609d-43d7-b744-b19fd207db56",name:"Oil collection preview",enabled:true,startsAt:"",endsAt:"",audience:"ALL",eyebrow:"Traditionally pressed",headline:"Your everyday oil collection.",body:"Explore cold-pressed groundnut, sesame and coconut oils. Sample products and illustrative prices.",buttonLabel:"Shop the offer",buttonUrl:"/shop",imageUrl:"",placement:"HOME_HERO",backgroundColor:"#e8d7aa"}],popups:[]};
export const recommendationRequestSchema=z.object({viewedProductIds:z.array(z.string().max(191)).max(50).default([]),cartProductIds:z.array(z.string().max(100)).max(30).default([]),categories:z.array(z.string().max(100)).max(30).default([]),limit:z.number().int().min(1).max(12).default(4)});
export function activeCampaign<T extends {enabled:boolean;startsAt:string;endsAt:string;audience:string}>(item:T,returning=false){const now=Date.now();return item.enabled&&(!item.startsAt||new Date(item.startsAt).getTime()<=now)&&(!item.endsAt||new Date(item.endsAt).getTime()>=now)&&(item.audience==="ALL"||(returning?item.audience==="RETURNING_VISITORS":item.audience==="NEW_VISITORS"));}

export function publicPromotionConfig(settings: PromotionConfig, returning = false): PromotionConfig {
  return {
    welcomePopupEnabled: settings.welcomePopupEnabled,
    announcementBars: settings.announcementBars.filter(item => activeCampaign(item, returning)),
    banners: settings.banners.filter(item => activeCampaign(item, returning) && (settings.welcomePopupEnabled || item.placement !== "HOME_HERO")),
    popups: settings.welcomePopupEnabled ? settings.popups.filter(item => activeCampaign(item, returning)) : [],
  };
}
