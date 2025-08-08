import { LightningElement, api, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import getLicenseData from '@salesforce/apex/LicenseQuantityController.getLicenseData';
import getCustomerSuccessModuleConfig from '@salesforce/apex/LicenseQuantityController.getCustomerSuccessModuleConfig';
import saveLicenseData from '@salesforce/apex/LicenseQuantityController.saveLicenseData';

export default class LicenseQuantityGrid extends LightningElement {
    @api recordId; // Customer_Success_Module__c record ID
    @track gridData = [];
    @track isLoading = false;
    @track hasChanges = false;
    @track pendingChanges = new Map();

    gradeLabels = ['K', '1', '2', '3', '4', '5', '6', '7', '8'];
    
    // Store the wired data for a potential refreshApex call
    wiredLicenseData;
    wiredConfigData;

    // The configuration data from the server, used for dynamic columns
    @track configData;

    // Test the config fetch - just log it for now, don't use it
    @wire(getCustomerSuccessModuleConfig, { customerSuccessModuleId: '$recordId' })
    wiredConfig(result) {
        this.wiredConfigData = result; // Store for potential refreshApex call if needed
        if (result.data) {
            this.configData = result.data; // Assign to a tracked property to trigger reactivity
            console.log('CSM Config received:', this.configData);
            if (this.wiredLicenseData) {
                refreshApex(this.wiredLicenseData);
            }
        } else if (result.error) {
            console.log('CSM Config error (expected if fields dont exist):', result.error);
        }
    }

    @wire(getLicenseData, { customerSuccessModuleId: '$recordId' })
    wiredGetLicenseData(result) {
        this.wiredLicenseData = result; // Assign the result directly
        if (result.data) {
            this.processLicenseData(result.data);
            console.log('License data received:', result.data);
        } else if (result.error) {
            this.showToast('Error', 'Failed to load license data: ' + result.error.body.message, 'error');
        }
    }

    // A getter property to dynamically generate columns based on the configData
    get columns() {
        // Check if configData is available before trying to use it
        if (!this.configData) {
            return []; // Return an empty array if data isn't loaded yet
        }
        const maxCols = this.configData.F5_Contract_Length__c ? parseInt(this.configData.F5_Contract_Length__c, 10) : 5;
        const zeroColumn = { label: 'Grade', fieldName: 'grade', type: 'text', editable: false, fixedWidth: 80 };
        let columns = [zeroColumn];

        for (let i = 1; i <= maxCols; i++) {
            let dateLabel;
            if (i === 1) {
                dateLabel = this.configData.F5_LMS_Start_Date__c || 'Year 1';
            } else {
                dateLabel = this.configData.F5_Initial_Renewal_date__c ? this.addYearsToDateString(this.configData.F5_Initial_Renewal_date__c, (i - 1)) : `Year ${i-1}`;
            }
                
            columns.push({
                label: dateLabel,
                fieldName: `year${i}`,
                type: 'number',
                editable: true,
                typeAttributes: { minimumFractionDigits: 0, maximumFractionDigits: 0 }
            });
        }
        return columns;
    }

    processLicenseData(data) {
        const dataMap = new Map();
        data.forEach(record => {
            const key = `${record.Grade_Level__c}_${record.Year__c}`;
            dataMap.set(key, record.License_Quantity__c);
        });

        // Ensure each row has a unique 'id' for datatable to track changes
        
        this.gridData = this.gradeLabels.map((grade, index) => {
            const row = { id: `row-${index}`, grade: grade }; // Add a unique 'id'
            
            const maxYears = (this.configData && this.configData.F5_Contract_Length__c) ? parseInt(this.configData.F5_Contract_Length__c, 10) : 7; // Default to 7 if not set
            for (let year = 1; year <= maxYears; year++) {
                const key = `${grade}_${year}`;
                row[`year${year}`] = dataMap.get(key) || null;
            }
            return row;
        });
    }

    // Renamed and re-purposed for tracking draft changes
    handleDraftValueChange(event) {
        const draftValues = event.detail.draftValues;
        this.hasChanges = true; // Indicate that there are pending changes

        // Create a new array for updated pendingChanges to ensure reactivity
        const updatedPendingChanges = new Map(this.pendingChanges); 

        draftValues.forEach(draft => {
            // Find the original row data based on the 'id' from draftValues
            const originalRow = this.gridData.find(row => row.id === draft.id);
            if (!originalRow) {
                console.error('Original row not found for draft ID:', draft.id);
                return;
            }
            const grade = originalRow.grade;

            // Update the gridData directly with draft values for immediate visual update
            // and to ensure subsequent drafts are based on the latest displayed data.
            // This is crucial for the datatable's inline editing to work correctly.
            const rowIndex = this.gridData.findIndex(row => row.id === draft.id);
            if (rowIndex !== -1) {
                // Merge the draft values into the current gridData row
                this.gridData = this.gridData.map((row, idx) => {
                    if (idx === rowIndex) {
                        return { ...row, ...draft };
                    }
                    return row;
                });
            }

            // Process each changed field for pendingChanges map
            Object.keys(draft).forEach(field => {
                if (field !== 'id' && field !== 'grade') { // 'grade' is fixed, 'id' is for internal tracking
                    const year = field.replace('year', '');
                    const key = `${grade}_${year}`;
                    let value = draft[field];

                    if (value !== null && value !== undefined && value !== '') {
                        value = parseInt(value, 10);
                        if (isNaN(value) || value < 0) {
                            value = null; // Set to null for invalid numbers or negatives
                        }
                    } else {
                        value = null; // Set to null if empty string or undefined
                    }

                    updatedPendingChanges.set(key, {
                        grade: grade,
                        year: year,
                        quantity: value
                    });
                }
            });
        });
        this.pendingChanges = updatedPendingChanges; // Update the track property
    }

    async handleSave() {
        if (!this.hasChanges || this.pendingChanges.size === 0) {
            this.showToast('Info', 'No changes to save.', 'info');
            return;
        }

        this.isLoading = true;

        try {
            const changes = Array.from(this.pendingChanges.values());
            console.log('Saving changes:', JSON.stringify(changes)); // Debugging

            await saveLicenseData({
                customerSuccessModuleId: this.recordId,
                licenseChanges: changes
            });

            this.showToast('Success', 'License quantities saved successfully', 'success');
            this.hasChanges = false;
            this.pendingChanges.clear(); // Clear pending changes after successful save

            // CRITICAL: Clear draft values from the datatable after successful save
            this.template.querySelector('lightning-datatable').draftValues = [];

            // Refresh data to show latest saved state and clear any red borders/unsaved indicators
            await refreshApex(this.wiredLicenseData);

        } catch (error) {
            let errorMessage = 'An unknown error occurred.';
            if (error && error.body && error.body.message) {
                errorMessage = error.body.message;
            } else if (error && error.message) {
                errorMessage = error.message;
            }
            this.showToast('Error', 'Failed to save changes: ' + errorMessage, 'error');
            console.error('Save error:', error); // Log the full error for debugging
        } finally {
            this.isLoading = false;
        }
    }

    handleCancel() {
        this.hasChanges = false;
        this.pendingChanges.clear();

        // CRITICAL: Clear draft values from the datatable
        this.template.querySelector('lightning-datatable').draftValues = [];

        // Refresh data to revert any changes not saved
        refreshApex(this.wiredLicenseData);
        this.showToast('Info', 'Changes discarded.', 'info');
    }
    addYearsToDateString(dateString, yearsToAdd) {
        if (!dateString) return null; // Handle cases where dateString is null
        const date = new Date(dateString);
        date.setFullYear(date.getFullYear() + yearsToAdd);
        return date.toISOString().split('T')[0]; // Return in YYYY-MM-DD format
    }
    showToast(title, message, variant) {
        const event = new ShowToastEvent({
            title: title,
            message: message,
            variant: variant
        });
        this.dispatchEvent(event);
    }

    get saveButtonDisabled() {
        // Only enable save button if there are changes and not currently loading
        return !this.hasChanges || this.isLoading;
    }

    get cancelButtonDisabled() {
        // Only enable cancel button if there are changes and not currently loading
        return !this.hasChanges || this.isLoading;
    }
}
