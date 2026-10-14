import {z} from "zod";
const attemptToken=z.string().min(80).max(2000);
export const paymentClientEventSchema=z.object({orderNumber:z.string().trim().min(3).max(40),providerOrderId:z.string().trim().min(3).max(200),attemptToken,type:z.enum(["CANCELLED","FAILED"]),gatewayPaymentId:z.string().trim().max(200).optional(),errorCode:z.string().trim().max(100).optional(),errorDescription:z.string().trim().max(300).optional()}).strict();
export const paymentRetrySchema=z.object({orderNumber:z.string().trim().min(3).max(40),provider:z.string().trim().min(2).max(40),attemptToken}).strict();
export const paymentReconcileSchema=z.object({paymentId:z.string().uuid()});
export type GatewayStatus={status:"CREATED"|"PENDING"|"AUTHORIZED"|"CAPTURED"|"FAILED"|"CANCELLED"|"REFUNDED"|"PARTIALLY_REFUNDED";gatewayPaymentId?:string;amount?:number;currency?:string;errorCode?:string;errorDescription?:string};
export type GatewayFailure={category:string;retryable:boolean;recommendedAction:"RETRY"|"CHANGE_METHOD"|"CONTACT_BANK"|"CONTACT_STORE"|"WAIT";customerMessage:string;retryAfterSeconds?:number};
export function classifyGatewayFailure(status:number,providerCode?:string,providerReason?:string):GatewayFailure{
  const signal=`${providerCode||""} ${providerReason||""}`.toUpperCase();
  if(status===429)return {category:"RATE_LIMIT",retryable:true,recommendedAction:"WAIT",customerMessage:"Too many payment attempts. Wait briefly and try again.",retryAfterSeconds:60};
  if(status>=500)return {category:"GATEWAY_UNAVAILABLE",retryable:true,recommendedAction:"RETRY",customerMessage:"The payment network is temporarily unavailable. Your order is saved; retry shortly.",retryAfterSeconds:30};
  if(status===401||status===403)return {category:"CONFIGURATION",retryable:false,recommendedAction:"CONTACT_STORE",customerMessage:"Online payment is temporarily unavailable. Choose another method or contact the store."};
  if(/INSUFFICIENT[_ ]FUNDS|LOW[_ ]BALANCE/.test(signal))return {category:"INSUFFICIENT_FUNDS",retryable:false,recommendedAction:"CHANGE_METHOD",customerMessage:"The account has insufficient funds. Use another payment method."};
  if(/EXPIRED/.test(signal))return {category:"CARD_EXPIRED",retryable:false,recommendedAction:"CHANGE_METHOD",customerMessage:"The card has expired. Use another payment method."};
  if(/OTP|AUTHENTICATION|3DSECURE|PIN/.test(signal))return {category:"AUTHENTICATION_FAILED",retryable:true,recommendedAction:"RETRY",customerMessage:"Payment authentication was not completed. Check the OTP or PIN and try again."};
  if(/UPI|VPA/.test(signal))return {category:"UPI_ERROR",retryable:true,recommendedAction:"RETRY",customerMessage:"The UPI request could not be completed. Verify the UPI ID or retry."};
  if(/BANK|ISSUER|DECLIN/.test(signal))return {category:"BANK_DECLINED",retryable:false,recommendedAction:"CONTACT_BANK",customerMessage:"The bank declined this payment. Contact the bank or use another method."};
  if(/CANCEL/.test(signal))return {category:"CUSTOMER_CANCELLED",retryable:true,recommendedAction:"RETRY",customerMessage:"Payment was cancelled. Your order is saved and can be paid again."};
  if(["BAD_REQUEST_ERROR","PAYMENT_DECLINED","CARD_DECLINED"].includes(providerCode||""))return {category:"DECLINED",retryable:false,recommendedAction:"CHANGE_METHOD",customerMessage:"The payment was declined. Check the details or use another method."};
  return {category:"PROVIDER_REJECTED",retryable:false,recommendedAction:"CHANGE_METHOD",customerMessage:"The payment could not be completed. Check the details or use another method."};
}
export function classifyTransportFailure(kind:"TIMEOUT"|"NETWORK"):GatewayFailure{return kind==="TIMEOUT"?{category:"TIMEOUT",retryable:true,recommendedAction:"WAIT",customerMessage:"The payment network did not respond. Check payment status before retrying.",retryAfterSeconds:30}:{category:"NETWORK_ERROR",retryable:true,recommendedAction:"RETRY",customerMessage:"A network error interrupted the payment request. Your order remains safe.",retryAfterSeconds:10}}
