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
    @track draftValues = [];

    gradeLabels = ['K', '1', '2', '3', '4', '5', '6', '7', '8'];
    
    // Store the wired data for a potential refreshApex call
    wiredLicenseData;
    wiredConfigData;

    // The configuration data from the server, used for dynamic columns
    @track configData;
    @track originalLicenseData = []; // Store original data for comparison

    @wire(getCustomerSuccessModuleConfig, { customerSuccessModuleId: '$recordId' })
    wiredConfig(result) {
        this.wiredConfigData = result; 
        if (result.data) {
            this.configData = result.data; 
            console.log('CSM Config received:', this.configData);
            // Reprocess license data if it's already available
            if (this.originalLicenseData.length > 0) {
                this.processLicenseData(this.originalLicenseData);
            }
        } else if (result.error) {
            console.error('CSM Config error:', result.error);
            this.showToast('Error', 'Failed to load configuration data', 'error');
        }
    }

    @wire(getLicenseData, { customerSuccessModuleId: '$recordId' })
    wiredGetLicenseData(result) {
        this.wiredLicenseData = result; 
        if (result.data) {
            this.originalLicenseData = result.data;
            console.log('License data received:', result.data);
            
            // Only process if config is also available
            if (this.configData) {
                this.processLicenseData(result.data);
            }
        } else if (result.error) {
            console.error('License data error:', result.error);
            this.showToast('Error', 'Failed to load license data: ' + result.error.body.message, 'error');
        }
    }
    
    get columns() {
        if (!this.configData) {
            return [];
        }
        
        const maxCols = this.configData.F5_Contract_Length__c ? parseInt(this.configData.F5_Contract_Length__c, 10) : 7;
        const zeroColumn = { 
            label: 'Grade', 
            fieldName: 'grade', 
            type: 'text', 
            editable: false, 
            fixedWidth: 80, 
            cellAttributes: { class: { fieldName: 'gradeClass' } } 
        };
        let columns = [zeroColumn];

        // Store the initial date to use as a starting point for the loop
        let currentDate = this.configData.F5_LMS_Start_Date__c;
        let nextDate = this.configData.F5_Initial_Renewal_date__c;

        for (let i = 1; i <= maxCols; i++) {
            let dateLabel;

            if (i === 1) {
                // Use the LMS Start Date for the first column, formatted
                dateLabel = currentDate ? this.americanDateFormat(currentDate) : 'Year 1';
            } else {
                dateLabel = nextDate ? this.americanDateFormat(this.addYearsToDateString(nextDate, (i - 2))) : `Year ${i}`;
            }

            columns.push({
                label: dateLabel,
                fieldName: `year${i}`,
                type: 'number',
                editable: true,
                typeAttributes: { 
                    minimumFractionDigits: 0, 
                    maximumFractionDigits: 0,
                    step: 1,
                    min: 0
                },
                cellAttributes: {
                    class: { fieldName: 'rowClass' }
                }
            });
        }
        return columns;
    }

    // Helper method to calculate the totals for each year
    calculateTotals(dataRows, maxYears) {
        // Create a row object for the totals
        const totals = { 
            id: 'totals-row', 
            grade: 'Total', 
            rowClass: 'total-row slds-text-heading_small slds-text-color_success', 
            gradeClass: 'slds-cell-edit slds-cell-edit_no-button'
        };
        
        for (let year = 1; year <= maxYears; year++) {
            const yearKey = `year${year}`;
            // Ensure numeric values and sum them
            totals[yearKey] = dataRows.reduce((sum, row) => {
                const value = row[yearKey];
                // Convert to number, defaulting to 0 if null/undefined/NaN
                const numValue = (value === null || value === undefined || value === '') ? 0 : parseInt(value, 10);
                return sum + (isNaN(numValue) ? 0 : numValue);
            }, 0);
        }
        return totals;
    }

    processLicenseData(data) {
        if (!this.configData) {
            console.log('Config data not available yet, skipping processLicenseData');
            return;
        }

        const dataMap = new Map();
        data.forEach(record => {
            const key = `${record.Grade_Level__c}_${record.Year__c}`;
            dataMap.set(key, record.License_Quantity__c);
        });

        const maxYears = this.configData.F5_Contract_Length__c ? parseInt(this.configData.F5_Contract_Length__c, 10) : 7;
        
        // Build the main data rows
        const mainData = this.gradeLabels.map((grade, index) => {
            const row = { id: `row-${index}`, grade: grade, rowClass: '', gradeClass: 'slds-cell-edit' }; 
            
            for (let year = 1; year <= maxYears; year++) {
                const key = `${grade}_${year}`;
                const value = dataMap.get(key);
                // Ensure consistent data types - use null for empty values, numbers for actual values
                row[`year${year}`] = (value === null || value === undefined) ? null : parseInt(value, 10);
            }
            return row;
        });

        // Calculate and add the totals row
        const totalsRow = this.calculateTotals(mainData, maxYears);
        this.gridData = [...mainData, totalsRow];
        
        console.log('Processed grid data:', this.gridData);
    }

    // Validation method to check if totals exceed maximum license limit
    validateTotals(dataRows) {
        if (!this.configData || !this.configData.F5_Maximum_License__c) {
            console.log('No maximum license configured, skipping validation');
            return { isValid: true, errors: [] };
        }

        const maxLicense = parseInt(this.configData.F5_Maximum_License__c, 10);
        const maxYears = this.configData.F5_Contract_Length__c ? parseInt(this.configData.F5_Contract_Length__c, 10) : 7;
        const errors = [];

        console.log('Validating totals - Max License:', maxLicense);
        console.log('Data rows for validation:', dataRows);

        for (let year = 1; year <= maxYears; year++) {
            const yearKey = `year${year}`;
            const total = dataRows.reduce((sum, row) => {
                const value = row[yearKey];
                const numValue = (value === null || value === undefined || value === '') ? 0 : parseInt(value, 10);
                return sum + (isNaN(numValue) ? 0 : numValue);
            }, 0);
            
            console.log(`Year ${year} total: ${total}, Max: ${maxLicense}`);
            
            if (total > maxLicense) {
                const yearLabel = this.getYearLabel(year);
                errors.push(`${yearLabel}: Total (${total}) exceeds maximum license limit (${maxLicense})`);
            }
        }

        const result = {
            isValid: errors.length === 0,
            errors: errors
        };
        
        console.log('Validation result:', result);
        return result;
    }

    // Helper method to get year label for validation messages
    getYearLabel(yearNum) {
        const columns = this.columns;
        if (columns && columns[yearNum]) {
            return columns[yearNum].label;
        }
        return `Year ${yearNum}`;
    }

    handleDraftValueChange(event) {
        const draftValues = event.detail.draftValues;
        console.log('Draft values received:', draftValues);
        
        // Filter out any draft values for the totals row to prevent editing
        const filteredDraftValues = draftValues.filter(draft => draft.id !== 'totals-row');
        
        if (filteredDraftValues.length === 0) {
            this.draftValues = [];
            return; // No valid changes to process
        }

        this.hasChanges = true; 
        this.draftValues = filteredDraftValues;

        // Clone the current grid data and filter out the totals row
        const currentDataRows = this.gridData
            .filter(row => row.id !== 'totals-row')
            .map(row => ({ ...row })); // Create a shallow copy

        // Apply the draft values to the cloned data
        const updatedDataRows = currentDataRows.map(row => {
            const draft = filteredDraftValues.find(d => d.id === row.id);
            if (draft) {
                // Apply draft changes
                const updatedRow = { ...row };
                Object.keys(draft).forEach(key => {
                    if (key !== 'id') {
                        let value = draft[key];
                        // Convert to integer or null
                        if (value === null || value === undefined || value === '') {
                            updatedRow[key] = null;
                        } else {
                            const intValue = parseInt(value, 10);
                            updatedRow[key] = isNaN(intValue) ? null : Math.max(0, intValue); // Ensure non-negative
                        }
                    }
                });
                return updatedRow;
            }
            return row;
        });

        // Recalculate totals based on the updated data rows
        const maxYears = this.configData ? parseInt(this.configData.F5_Contract_Length__c, 10) || 7 : 7;
        const totalsRow = this.calculateTotals(updatedDataRows, maxYears);
        
        // Update the grid with the new data rows and the recalculated totals
        this.gridData = [...updatedDataRows, totalsRow];

        // Update pending changes for saving
        const updatedPendingChanges = new Map(this.pendingChanges);

        filteredDraftValues.forEach(draft => {
            const originalRow = updatedDataRows.find(row => row.id === draft.id);
            if (!originalRow) {
                console.error('Original row not found for draft ID:', draft.id);
                return;
            }
            const grade = originalRow.grade;

            Object.keys(draft).forEach(field => {
                if (field !== 'id' && field !== 'grade' && field.startsWith('year')) { 
                    const year = field.replace('year', '');
                    const key = `${grade}_${year}`;
                    let value = draft[field];

                    if (value !== null && value !== undefined && value !== '') {
                        value = parseInt(value, 10);
                        if (isNaN(value) || value < 0) {
                            value = null; 
                        }
                    } else {
                        value = null; 
                    }

                    updatedPendingChanges.set(key, {
                        grade: grade,
                        year: year,
                        quantity: value
                    });
                }
            });
        });

        this.pendingChanges = updatedPendingChanges;

        // Validate totals after updating the grid
        const validation = this.validateTotals(updatedDataRows);
        
        if (!validation.isValid) {
            // Show validation errors as warnings during editing
            const errorMessage = validation.errors.join('\n');
            this.showToast('Warning', errorMessage, 'warning');
        }
    }

    async handleSave() {
        if (!this.hasChanges || this.pendingChanges.size === 0) {
            this.showToast('Info', 'No changes to save.', 'info');
            return;
        }

        // Final validation before saving
        const dataRows = this.gridData.filter(row => row.id !== 'totals-row');
        const validation = this.validateTotals(dataRows);
        
        if (!validation.isValid) {
            const errorMessage = 'Cannot save due to validation errors:\n' + validation.errors.join('\n');
            this.showToast('Error', errorMessage, 'error');
            return;
        }

        this.isLoading = true;

        try {
            const changes = Array.from(this.pendingChanges.values());
            console.log('Saving changes:', JSON.stringify(changes)); 

            await saveLicenseData({
                customerSuccessModuleId: this.recordId,
                licenseChanges: changes
            });

            this.showToast('Success', 'License quantities saved successfully', 'success');
            this.hasChanges = false;
            this.pendingChanges.clear(); 
            this.draftValues = [];

            // Clear draft values from the datatable
            const datatable = this.template.querySelector('lightning-datatable');
            if (datatable) {
                datatable.draftValues = [];
            }

            // Refresh data
            await refreshApex(this.wiredLicenseData);

        } catch (error) {
            let errorMessage = 'An unknown error occurred.';
            if (error && error.body && error.body.message) {
                errorMessage = error.body.message;
            } else if (error && error.message) {
                errorMessage = error.message;
            }
            this.showToast('Error', 'Failed to save changes: ' + errorMessage, 'error');
            console.error('Save error:', error); 
        } finally {
            this.isLoading = false;
        }
    }

    handleCancel() {
        this.hasChanges = false;
        this.pendingChanges.clear();
        this.draftValues = [];

        // Clear draft values from the datatable
        const datatable = this.template.querySelector('lightning-datatable');
        if (datatable) {
            datatable.draftValues = [];
        }

        // Refresh to original data
        refreshApex(this.wiredLicenseData);
        this.showToast('Info', 'Changes discarded.', 'info');
    }
    
    addYearsToDateString(dateString, yearsToAdd) {
        if (!dateString) return null;
        try {
            const date = new Date(dateString);
            date.setFullYear(date.getFullYear() + yearsToAdd);
            return date.toISOString().split('T')[0]; 
        } catch (e) {
            console.error('Error adding years to date:', e);
            return null;
        }
    }
    
    americanDateFormat(inputDate) {
        if (!inputDate) return null;
        
        try {
            // Handle both string and Date inputs
            const date = typeof inputDate === 'string' ? new Date(inputDate) : inputDate;
            
            if (isNaN(date.getTime())) {
                return null; // Invalid date
            }
            
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            const year = date.getFullYear();
            
            return `${month}/${day}/${year}`;
        } catch (e) {
            console.error('Error formatting date:', e);
            return null;
        }
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
        return !this.hasChanges || this.isLoading;
    }

    get cancelButtonDisabled() {
        return !this.hasChanges || this.isLoading;
    }
}