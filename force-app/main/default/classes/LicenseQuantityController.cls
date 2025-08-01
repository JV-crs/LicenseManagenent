//Testing deployment
public with sharing class LicenseQuantityController {
    
    @AuraEnabled(cacheable=true)
    public static List<Fly_Five_License_Quantity__c> getLicenseData(Id customerSuccessModuleId) {
        if(customerSuccessModuleId == null){throw new AuraHandledException('Null Id');}
        try {
            return [
                SELECT Id, Grade_Level__c, Year__c, License_Quantity__c, Customer_Success_Module__c
                FROM Fly_Five_License_Quantity__c 
                WHERE Customer_Success_Module__c = :customerSuccessModuleId
                ORDER BY Grade_Level__c, Year__c
            ];
        } catch (Exception e) {
            throw new AuraHandledException('Error retrieving license data: ' + e.getMessage());
        }
    }
    
    @AuraEnabled
    public static void saveLicenseData(Id customerSuccessModuleId, List<LicenseChangeWrapper> licenseChanges) {
        try {
            // Get existing records for this Customer Success Module
            Map<String, Fly_Five_License_Quantity__c> existingRecords = new Map<String, Fly_Five_License_Quantity__c>();
            List<Fly_Five_License_Quantity__c> currentRecords = [
                SELECT Id, Grade_Level__c, Year__c, License_Quantity__c, Customer_Success_Module__c
                FROM Fly_Five_License_Quantity__c 
                WHERE Customer_Success_Module__c = :customerSuccessModuleId
            ];
            
            for (Fly_Five_License_Quantity__c record : currentRecords) {
                String key = record.Grade_Level__c + '_' + record.Year__c;
                existingRecords.put(key, record);
            }
            
            List<Fly_Five_License_Quantity__c> recordsToUpsert = new List<Fly_Five_License_Quantity__c>();
            List<Fly_Five_License_Quantity__c> recordsToDelete = new List<Fly_Five_License_Quantity__c>();
            
            for (LicenseChangeWrapper change : licenseChanges) {
                String key = change.grade + '_' + change.year;
                Fly_Five_License_Quantity__c existingRecord = existingRecords.get(key);
                
                if (change.quantity == null || change.quantity <= 0) {
                    // Delete the record if quantity is null or zero
                    if (existingRecord != null) {
                        recordsToDelete.add(existingRecord);
                    }
                } else {
                    // Create or update record
                    Fly_Five_License_Quantity__c record;
                    if (existingRecord != null) {
                        record = existingRecord;
                    } else {
                        record = new Fly_Five_License_Quantity__c();
                        record.Customer_Success_Module__c = customerSuccessModuleId;
                        record.Grade_Level__c = change.grade;
                        record.Year__c = change.year; // Now handled as String for picklist
                    }
                    record.License_Quantity__c = change.quantity;
                    recordsToUpsert.add(record);
                }
            }
            
            // Perform DML operations
            if (!recordsToUpsert.isEmpty()) {
                upsert recordsToUpsert;
            }
            
            if (!recordsToDelete.isEmpty()) {
                delete recordsToDelete;
            }
            
        } catch (DmlException e) {
            throw new AuraHandledException('Error saving license data: ' + e.getDmlMessage(0));
        } catch (Exception e) {
            throw new AuraHandledException('Unexpected error: ' + e.getMessage());
        }
    }
    
    // Wrapper class for license changes
    public class LicenseChangeWrapper {
        @AuraEnabled
        public String grade { get; set; }
        
        @AuraEnabled
        public String year { get; set; } 
        
        @AuraEnabled
        public Integer quantity { get; set; }
    }
}